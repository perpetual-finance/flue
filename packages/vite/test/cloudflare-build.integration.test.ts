/**
 * Cloudflare-target `vite build` / `vite preview`: the sibling plugin owns
 * the Worker build (per-environment output under dist/) and preview (workerd
 * over the built artifact); flue supplies the generated entry + wrangler
 * inputs at config-resolution time and stays out of the way in preview.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { cloudflare } from '@cloudflare/vite-plugin';
import { createBuilder, type PreviewServer, preview } from 'vite';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { flue } from '../src/index.ts';
import {
	basicCloudflareProjectFiles,
	type FakeModelServer,
	startFakeModelServer,
} from './helpers/cloudflare-fixture.ts';
import { createFixture, type Fixture, getAvailablePort, waitFor } from './helpers/fixture.ts';

let fakeModel: FakeModelServer;
const fixtures: Fixture[] = [];
const previewServers: PreviewServer[] = [];

beforeAll(async () => {
	fakeModel = await startFakeModelServer();
});

afterAll(async () => {
	await fakeModel.close();
});

afterEach(async () => {
	for (const server of previewServers.splice(0)) {
		await server.close().catch(() => undefined);
	}
	for (const fixture of fixtures.splice(0)) fixture.cleanup();
	delete process.env.CLOUDFLARE_VITE_WRANGLER_CONFIG_PATH;
});

function findFiles(dir: string, basename: string): string[] {
	if (!fs.existsSync(dir)) return [];
	const found: string[] = [];
	for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
		const fullPath = path.join(dir, entry.name);
		if (entry.isDirectory()) found.push(...findFiles(fullPath, basename));
		else if (entry.name === basename) found.push(fullPath);
	}
	return found;
}

async function buildFixture(fixture: Fixture) {
	const builder = await createBuilder({
		root: fixture.root,
		configFile: false,
		logLevel: 'error',
		plugins: [flue(), cloudflare({ persistState: false, inspectorPort: false })],
	});
	await builder.buildApp();
}

describe('vite build (cloudflare target)', () => {
	it('produces a deployable Worker artifact with per-agent DO classes, bindings, and user migrations preserved', async () => {
		const fixture = createFixture(basicCloudflareProjectFiles({ modelPort: fakeModel.port }));
		fixtures.push(fixture);
		await buildFixture(fixture);

		const distDir = path.join(fixture.root, 'dist');
		const [outputConfigPath, ...extraConfigs] = findFiles(distDir, 'wrangler.json');
		expect(outputConfigPath, 'exactly one output wrangler.json').toBeDefined();
		expect(extraConfigs).toEqual([]);
		const outputConfig = JSON.parse(fs.readFileSync(outputConfigPath as string, 'utf8')) as {
			name: string;
			main: string;
			compatibility_flags: string[];
			durable_objects: { bindings: Array<{ name: string; class_name: string }> };
			migrations: unknown[];
		};

		// User-authored values pass through; Flue's contributions are present.
		expect(outputConfig.name).toBe('flue-cf-fixture');
		expect(outputConfig.compatibility_flags).toContain('nodejs_compat');
		expect(outputConfig.durable_objects.bindings).toContainEqual({
			name: 'FLUE_ECHO_AGENT',
			class_name: 'FlueEchoAgent',
		});
		expect(outputConfig.migrations).toEqual([
			{ tag: 'v1', new_sqlite_classes: ['FlueEchoAgent'] },
		]);

		// The bundled Worker module exists next to the output config and
		// exports the per-agent Durable Object class.
		const workerDir = path.dirname(outputConfigPath as string);
		const mainPath = path.resolve(workerDir, outputConfig.main);
		expect(fs.existsSync(mainPath)).toBe(true);
		expect(fs.readFileSync(mainPath, 'utf8')).toContain('FlueEchoAgent');
	}, 180_000);

	it('serves the built artifact through vite preview (sibling-owned, no source scanning required)', async () => {
		const fixture = createFixture(basicCloudflareProjectFiles({ modelPort: fakeModel.port }));
		fixtures.push(fixture);
		await buildFixture(fixture);

		// Preview must not depend on source state: remove the source tree (and
		// the generated inputs) so only the built artifact remains.
		fixture.remove('src');
		fixture.remove('.flue-vite');
		fixture.remove('.flue-vite.wrangler.jsonc');

		const port = await getAvailablePort();
		const server = await preview({
			root: fixture.root,
			configFile: false,
			logLevel: 'error',
			plugins: [flue(), cloudflare({ persistState: false, inspectorPort: false })],
			preview: { port, strictPort: true, host: '127.0.0.1' },
		});
		previewServers.push(server);
		const baseUrl = `http://127.0.0.1:${port}`;
		await waitFor(
			async () => {
				const response = await fetch(`${baseUrl}/api/ping`);
				return response.ok && (await response.text()) === 'pong';
			},
			{ description: 'the previewed Worker artifact to serve', timeoutMs: 60_000 },
		);
	}, 180_000);
});
