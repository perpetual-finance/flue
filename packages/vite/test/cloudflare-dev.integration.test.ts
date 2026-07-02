/**
 * Cloudflare-target `vite dev` end-to-end: flue() + cloudflare() run workerd,
 * serve the mounted app, and flue's supervision keeps the generated inputs
 * (Worker entry + merged wrangler config) fresh on marked-set changes without
 * restart loops — while body edits regenerate nothing.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { cloudflare } from '@cloudflare/vite-plugin';
import { createServer, type ViteDevServer } from 'vite';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { flue } from '../src/index.ts';
import {
	basicCloudflareProjectFiles,
	CF_ECHO_AGENT_MODULE,
	cloudflareWranglerJson,
	type FakeModelServer,
	startFakeModelServer,
} from './helpers/cloudflare-fixture.ts';
import {
	createFixture,
	type Fixture,
	getAvailablePort,
	readStreamUntil,
	waitFor,
} from './helpers/fixture.ts';

let fakeModel: FakeModelServer;
const fixtures: Fixture[] = [];
const servers: ViteDevServer[] = [];

beforeAll(async () => {
	fakeModel = await startFakeModelServer();
});

afterAll(async () => {
	await fakeModel.close();
});

afterEach(async () => {
	for (const server of servers.splice(0)) {
		await server.close().catch(() => undefined);
	}
	for (const fixture of fixtures.splice(0)) fixture.cleanup();
	delete process.env.CLOUDFLARE_VITE_WRANGLER_CONFIG_PATH;
});

function fixtureOf(files: Record<string, string>): Fixture {
	const fixture = createFixture(files);
	fixtures.push(fixture);
	return fixture;
}

async function startDev(fixture: Fixture) {
	const port = await getAvailablePort();
	const server = await createServer({
		root: fixture.root,
		configFile: false,
		logLevel: 'error',
		// Per-fixture dep-optimizer cache; see cloudflare-extensions test.
		cacheDir: path.join(fixture.root, '.vite-cache'),
		plugins: [flue(), cloudflare({ persistState: false, inspectorPort: false })],
		server: { port, strictPort: true, host: '127.0.0.1' },
	});
	await server.listen();
	servers.push(server);
	const baseUrl = `http://127.0.0.1:${port}`;
	await waitFor(
		async () => {
			const response = await fetch(`${baseUrl}/api/ping`);
			return response.ok && (await response.text()) === 'pong';
		},
		{ description: 'the workerd dev application to become ready', timeoutMs: 60_000 },
	);
	return { server, baseUrl };
}

async function promptAdmits(baseUrl: string, mount: string, id: string, body: string) {
	return fetch(`${baseUrl}${mount}/${id}`, {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({ kind: 'user', body }),
	});
}

function generatedInputSnapshots(root: string) {
	const entryPath = path.join(root, '.flue-vite', '_entry.ts');
	const wranglerPath = path.join(root, '.flue-vite.wrangler.jsonc');
	return {
		entry: fs.readFileSync(entryPath, 'utf8'),
		entryMtimeMs: fs.statSync(entryPath).mtimeMs,
		wrangler: fs.readFileSync(wranglerPath, 'utf8'),
		wranglerMtimeMs: fs.statSync(wranglerPath).mtimeMs,
	};
}

const WRITER_APP_MODULE = `import { Hono } from 'hono';
import './test-model.ts';
import echo from './agents/echo.ts';
import writer from './agents/writer.ts';

const app = new Hono();
app.get('/api/ping', (c) => c.text('pong'));
app.route('/agents/echo', echo.route());
app.route('/agents/writer', writer.route());

export default app;
`;

describe('vite dev (cloudflare target)', () => {
	it('serves a mounted agent conversation through workerd, keeps body edits regeneration-free, and follows agent add/remove', async () => {
		const fixture = fixtureOf(basicCloudflareProjectFiles({ modelPort: fakeModel.port }));
		const { baseUrl } = await startDev(fixture);

		// Custom route runs inside the Worker.
		const ping = await fetch(`${baseUrl}/api/ping`);
		expect(await ping.text()).toBe('pong');

		// Dev CORS matches the Node target: a separate-origin local client (the
		// demo chat app) must see the reflected origin and the durable-stream
		// coordination headers exposed.
		const crossOrigin = await fetch(`${baseUrl}/api/ping`, {
			headers: { Origin: 'http://localhost:5174' },
		});
		expect(crossOrigin.headers.get('access-control-allow-origin')).toBe('http://localhost:5174');
		expect(crossOrigin.headers.get('access-control-allow-credentials')).toBe('true');
		expect(crossOrigin.headers.get('access-control-expose-headers')).toContain(
			'Stream-Next-Offset',
		);

		// Prompt admission + streamed conversation read against the agent's
		// Durable Object (the fake provider in the test process produces the
		// assistant turn — worker outbound fetch reaches loopback).
		const admitted = await promptAdmits(baseUrl, '/agents/echo', 'cf-1', 'hi from workerd');
		expect(admitted.status).toBe(202);
		const streamed = await waitFor(
			async () => {
				const stream = await fetch(`${baseUrl}/agents/echo/cf-1`);
				if (stream.status !== 200) return false;
				return readStreamUntil(stream, (text) => text.includes('Hello from the fake model.'));
			},
			{ description: 'the assistant reply in the workerd conversation stream' },
		);
		expect(streamed).toContain('hi from workerd');

		// Body edit: the worker module graph reloads, but neither generated
		// input is rewritten (content-aware regeneration).
		const before = generatedInputSnapshots(fixture.root);
		fixture.write(
			'src/app.ts',
			basicCloudflareProjectFiles({ modelPort: fakeModel.port })['src/app.ts']?.replace(
				`c.text('pong')`,
				`c.text('pong-v2')`,
			) ?? '',
		);
		await waitFor(async () => (await (await fetch(`${baseUrl}/api/ping`)).text()) === 'pong-v2', {
			description: 'the edited app module to serve through workerd',
		});
		const afterBodyEdit = generatedInputSnapshots(fixture.root);
		expect(afterBodyEdit.entry).toBe(before.entry);
		expect(afterBodyEdit.entryMtimeMs).toBe(before.entryMtimeMs);
		expect(afterBodyEdit.wrangler).toBe(before.wrangler);
		expect(afterBodyEdit.wranglerMtimeMs).toBe(before.wranglerMtimeMs);

		// Agent add — the documented triple: agent file + app.ts mount +
		// user-authored migration tag. flue regenerates entry + wrangler and
		// the sibling picks the new config up (config-watch restart).
		fixture.write('src/agents/writer.ts', CF_ECHO_AGENT_MODULE);
		fixture.write(
			'wrangler.jsonc',
			cloudflareWranglerJson({
				name: 'flue-cf-fixture',
				migrations: [
					{ tag: 'v1', new_sqlite_classes: ['FlueEchoAgent'] },
					{ tag: 'v2', new_sqlite_classes: ['FlueWriterAgent'] },
				],
			}),
		);
		fixture.write('src/app.ts', WRITER_APP_MODULE);
		await waitFor(
			async () => {
				const response = await promptAdmits(baseUrl, '/agents/writer', 'cf-2', 'hello writer');
				return response.status === 202;
			},
			{
				description: 'the added agent to admit prompts through its new Durable Object',
				timeoutMs: 60_000,
			},
		);
		const afterAdd = generatedInputSnapshots(fixture.root);
		expect(afterAdd.entry).toContain('FlueWriterAgent');
		expect(afterAdd.wrangler).toContain('FLUE_WRITER_AGENT');

		// Agent remove: drop the file, unmount, and revert the migration tag
		// (dev fixture; production migrations would append deleted_classes).
		fixture.remove('src/agents/writer.ts');
		fixture.write(
			'src/app.ts',
			basicCloudflareProjectFiles({ modelPort: fakeModel.port })['src/app.ts']?.replace(
				`c.text('pong')`,
				`c.text('pong-v3')`,
			) ?? '',
		);
		fixture.write(
			'wrangler.jsonc',
			cloudflareWranglerJson({
				name: 'flue-cf-fixture',
				migrations: [{ tag: 'v1', new_sqlite_classes: ['FlueEchoAgent'] }],
			}),
		);
		await waitFor(
			async () => (await (await fetch(`${baseUrl}/api/ping`)).text()) === 'pong-v3',
			{ description: 'the dev server to recover after the agent removal', timeoutMs: 60_000 },
		);
		const afterRemove = generatedInputSnapshots(fixture.root);
		expect(afterRemove.entry).not.toContain('FlueWriterAgent');
		expect(afterRemove.wrangler).not.toContain('FLUE_WRITER_AGENT');
		// Probe through any still-queued sibling restart (fetches during a
		// restart drop the connection; waitFor retries).
		await waitFor(
			async () => (await promptAdmits(baseUrl, '/agents/writer', 'cf-3', 'gone')).status === 404,
			{ description: 'the removed agent mount to 404', timeoutMs: 60_000 },
		);

		// The surviving agent still admits prompts (no restart loop wedged the
		// server).
		await waitFor(
			async () =>
				(await promptAdmits(baseUrl, '/agents/echo', 'cf-1', 'still here')).status === 202,
			{ description: 'the surviving agent to admit prompts', timeoutMs: 60_000 },
		);
	}, 240_000);
});
