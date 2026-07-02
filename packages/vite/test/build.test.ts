import { type ChildProcess, spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { build, preview } from 'vite';
import { afterEach, describe, expect, it } from 'vitest';
import type { FlueVitePluginApi } from '../src/index.ts';
import { flue } from '../src/index.ts';
import {
	BASIC_APP_MODULE,
	basicNodeProjectFiles,
	createFixture,
	ECHO_AGENT_MODULE,
	type Fixture,
	getAvailablePort,
	readStreamUntil,
	TEST_MODEL_MODULE,
	waitFor,
} from './helpers/fixture.ts';

const fixtures: Fixture[] = [];
const children: ChildProcess[] = [];

afterEach(async () => {
	for (const child of children.splice(0)) {
		if (child.exitCode === null && child.signalCode === null) {
			const exited = new Promise((resolve) => child.once('exit', resolve));
			child.kill('SIGTERM');
			await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 5_000))]);
			if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
		}
	}
	for (const fixture of fixtures.splice(0)) fixture.cleanup();
});

function fixtureOf(files: Record<string, string>): Fixture {
	const fixture = createFixture(files);
	fixtures.push(fixture);
	return fixture;
}

async function buildFixture(fixture: Fixture) {
	const plugins = flue();
	await build({
		root: fixture.root,
		configFile: false,
		logLevel: 'error',
		plugins,
	});
	return plugins;
}

describe('vite build (node target)', () => {
	it('produces a self-starting dist/server.mjs that serves mounted routes and admits agent prompts', async () => {
		const fixture = fixtureOf(basicNodeProjectFiles());
		const plugins = await buildFixture(fixture);

		const serverPath = path.join(fixture.root, 'dist', 'server.mjs');
		expect(fs.existsSync(serverPath)).toBe(true);
		expect(fs.existsSync(`${serverPath}.map`)).toBe(true);
		// The non-listening application chunk, for artifact-based consumers
		// (`vite preview`, custom hosts).
		expect(fs.existsSync(path.join(fixture.root, 'dist', 'app.mjs'))).toBe(true);

		// The plugin api exposes the resolved project + scan results.
		const core = plugins.find((plugin) => plugin.name === 'flue');
		const api = core?.api as FlueVitePluginApi;
		expect(api.resolved).toBeDefined();
		expect(api.resolved?.target).toBe('node');
		expect(api.resolved?.project.app).toBe(path.join(fixture.root, 'src', 'app.ts'));
		expect(api.resolved?.agents.map((agent) => agent.identity)).toEqual(['echo']);

		const port = await getAvailablePort();
		const env: NodeJS.ProcessEnv = { ...process.env, PORT: String(port) };
		delete env.FORCE_COLOR; // known env leak issue when spawning processes
		const child = spawn(process.execPath, [serverPath], {
			cwd: fixture.root,
			env,
			stdio: ['ignore', 'pipe', 'pipe'],
		});
		children.push(child);
		let output = '';
		child.stdout?.on('data', (data) => {
			output += String(data);
		});
		child.stderr?.on('data', (data) => {
			output += String(data);
		});

		const baseUrl = `http://127.0.0.1:${port}`;
		await waitFor(
			async () => {
				const response = await fetch(`${baseUrl}/api/ping`);
				return response.ok;
			},
			{ description: `server.mjs to listen (output so far: ${output})` },
		);

		// Mounted custom route.
		const ping = await fetch(`${baseUrl}/api/ping`);
		expect(await ping.text()).toBe('pong');

		// Agent prompt admission (202) on the mounted agent route.
		const admitted = await fetch(`${baseUrl}/agents/echo/conv-1`, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ kind: 'user', body: 'hi there' }),
		});
		expect(admitted.status).toBe(202);
		const admission = (await admitted.json()) as { streamUrl: string; submissionId: string };
		expect(admission.streamUrl).toBe(`${baseUrl}/agents/echo/conv-1`);

		// The conversation stream serves the user message and (via the fixture's
		// offline fake provider) the assistant reply once the turn settles.
		const streamed = await waitFor(
			async () => {
				const stream = await fetch(`${baseUrl}/agents/echo/conv-1`);
				if (stream.status !== 200) return false;
				const text = await readStreamUntil(stream, (body) =>
					body.includes('Hello from the fake model.'),
				);
				return text;
			},
			{
				timeoutMs: 30_000,
				description: `the assistant reply in the conversation stream (output: ${output})`,
			},
		);
		expect(streamed).toContain('hi there');

		// Graceful SIGTERM shutdown (exit code 143 per the entry's handler).
		const exited = new Promise<number | null>((resolve) => child.once('exit', resolve));
		child.kill('SIGTERM');
		const code = await exited;
		expect(code).toBe(143);
	}, 120_000);

	it('fails with the app.ts starter diagnostic when no app entry exists', async () => {
		const fixture = fixtureOf({ 'src/agents/echo.ts': ECHO_AGENT_MODULE });
		await expect(buildFixture(fixture)).rejects.toThrow(/No app entry found[\s\S]*Hono/);
	});

	it('fails with the duplicate-identity diagnostic when two agent files share a basename', async () => {
		const files = basicNodeProjectFiles();
		const fixture = fixtureOf({
			...files,
			'src/more/echo.ts': ECHO_AGENT_MODULE,
		});
		await expect(buildFixture(fixture)).rejects.toThrow(/Duplicate agent identit/);
	});

	it('honors a discovered flue.config.ts with inline flue() options winning', async () => {
		const fixture = fixtureOf({
			'src/test-model.ts': TEST_MODEL_MODULE,
			'src/agents/echo.ts': ECHO_AGENT_MODULE,
			// The real app lives at a non-default path, configured via flue.config.ts.
			'src/server-main.ts': BASIC_APP_MODULE,
			'flue.config.ts': `import { defineConfig } from '@flue/runtime/config';
export default defineConfig({ app: './src/server-main.ts' });
`,
		});
		const plugins = flue();
		await build({ root: fixture.root, configFile: false, logLevel: 'error', plugins });
		const api = plugins.find((plugin) => plugin.name === 'flue')?.api as FlueVitePluginApi;
		expect(api.resolved?.configPath).toBe(path.join(fixture.root, 'flue.config.ts'));
		expect(api.resolved?.project.app).toBe(path.join(fixture.root, 'src', 'server-main.ts'));
		expect(fs.existsSync(path.join(fixture.root, 'dist', 'server.mjs'))).toBe(true);

		// Inline options merge over the discovered config (inline wins).
		const inline = flue({ app: './src/server-main.ts' });
		const fixture2 = fixtureOf({
			...basicNodeProjectFiles(),
			'src/server-main.ts': BASIC_APP_MODULE,
			'flue.config.ts': `export default { app: './src/app.ts' };\n`,
		});
		await build({ root: fixture2.root, configFile: false, logLevel: 'error', plugins: inline });
		const inlineApi = inline.find((plugin) => plugin.name === 'flue')?.api as FlueVitePluginApi;
		expect(inlineApi.resolved?.project.app).toBe(path.join(fixture2.root, 'src', 'server-main.ts'));
	}, 120_000);

	it('serves the built application under vite preview and stops it on close', async () => {
		const fixture = fixtureOf(basicNodeProjectFiles());
		await buildFixture(fixture);

		const port = await getAvailablePort();
		const previewServer = await preview({
			root: fixture.root,
			configFile: false,
			logLevel: 'error',
			plugins: flue(),
			preview: { port, strictPort: true, host: '127.0.0.1' },
		});
		try {
			const baseUrl = `http://127.0.0.1:${port}`;
			const ping = await fetch(`${baseUrl}/api/ping`);
			expect(await ping.text()).toBe('pong');

			// Preview defaults to the dev CORS policy so separate-origin local
			// clients (the demo chat app) can read the stream headers.
			const crossOrigin = await fetch(`${baseUrl}/api/ping`, {
				headers: { Origin: 'http://localhost:5174' },
			});
			expect(crossOrigin.headers.get('access-control-allow-origin')).toBe(
				'http://localhost:5174',
			);
			expect(crossOrigin.headers.get('access-control-expose-headers')).toContain(
				'Stream-Next-Offset',
			);

			// The full durable admission path works against the artifact.
			const admitted = await fetch(`${baseUrl}/agents/echo/preview-1`, {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ kind: 'user', body: 'hi preview' }),
			});
			expect(admitted.status).toBe(202);
			await waitFor(
				async () => {
					const stream = await fetch(`${baseUrl}/agents/echo/preview-1`);
					if (stream.status !== 200) return false;
					return readStreamUntil(stream, (text) => text.includes('Hello from the fake model.'));
				},
				{ description: 'the assistant reply in the preview conversation stream' },
			);
		} finally {
			await previewServer.close();
		}
	}, 120_000);

	it('fails preview with build guidance when no artifact exists', async () => {
		const fixture = fixtureOf(basicNodeProjectFiles());
		await expect(
			preview({ root: fixture.root, configFile: false, logLevel: 'silent', plugins: flue() }),
		).rejects.toThrow(/Run `vite build` first/);
	});

	it('fails with the missing-sibling diagnostic when the target is cloudflare without the plugin', async () => {
		const fixture = fixtureOf(basicNodeProjectFiles());
		fixture.write('flue.config.ts', `export default { target: 'cloudflare' };\n`);
		await expect(buildFixture(fixture)).rejects.toThrow(
			/@cloudflare\/vite-plugin is not in the Vite plugin array/,
		);
	});
});
