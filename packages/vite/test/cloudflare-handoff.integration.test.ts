/**
 * Step-1 checkpoint of the Phase 4 Cloudflare adapter: prove that flue()'s
 * `config` hook prepares the generated wrangler config and hands it to a
 * sibling `cloudflare()` plugin at config-resolution time, across the three
 * invocation forms (project dir, positional root, explicit --config path).
 *
 * Mechanism under test: flue writes `.flue-vite.wrangler.jsonc` and sets the
 * documented `CLOUDFLARE_VITE_WRANGLER_CONFIG_PATH` env var before the
 * sibling's `config` hook resolves (`cloudflare({ configPath }) ??
 * loadEnv(..., 'CLOUDFLARE_')`, and Vite's loadEnv includes matching
 * process.env variables).
 *
 * Proof discriminator: the fixtures have NO authored wrangler.* file, so the
 * sibling has no fallback config to discover — a Worker environment (named
 * after the generated config's default worker name) can only appear in the
 * resolved Vite config if the handoff worked.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { cloudflare } from '@cloudflare/vite-plugin';
import { type Plugin, resolveConfig } from 'vite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FlueVitePluginApi } from '../src/index.ts';
import { flue } from '../src/index.ts';
import {
	CF_ECHO_AGENT_MODULE,
	cloudflareTestModelModule,
	cloudflareWranglerJson,
} from './helpers/cloudflare-fixture.ts';
import { createFixture, type Fixture } from './helpers/fixture.ts';

const PACKAGE_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const fixtures: Fixture[] = [];
const originalCwd = process.cwd();

beforeEach(() => {
	// Prove flue sets the handoff variable itself (and isolate the sibling's
	// own loadEnv → process.env writeback between tests).
	delete process.env.CLOUDFLARE_VITE_WRANGLER_CONFIG_PATH;
});

afterEach(() => {
	process.chdir(originalCwd);
	delete process.env.CLOUDFLARE_VITE_WRANGLER_CONFIG_PATH;
	for (const fixture of fixtures.splice(0)) fixture.cleanup();
});

/**
 * A project WITHOUT an authored wrangler config, nested under a fixed-name
 * directory so the generated default worker name (the root basename) — and
 * with it the sibling's derived environment name — is deterministic.
 */
function handoffProjectRoot(): string {
	const fixture = createFixture({
		'handoff-proof/src/test-model.ts': cloudflareTestModelModule(1),
		'handoff-proof/src/agents/echo.ts': CF_ECHO_AGENT_MODULE,
		'handoff-proof/src/app.ts': `import { Hono } from 'hono';
import './test-model.ts';
import echo from './agents/echo.ts';
const app = new Hono();
app.get('/api/ping', (c) => c.text('pong'));
app.route('/agents/echo', echo.route());
export default app;
`,
	});
	fixtures.push(fixture);
	return path.join(fixture.root, 'handoff-proof');
}

function flueApiOf(plugins: Plugin[]): FlueVitePluginApi {
	const core = plugins.find((plugin) => plugin.name === 'flue');
	if (!core) throw new Error('flue core plugin missing');
	return core.api as FlueVitePluginApi;
}

interface HandoffExpectation {
	root: string;
	environments: Record<string, unknown>;
	api?: FlueVitePluginApi;
}

function expectHandoff({ root, environments, api }: HandoffExpectation): void {
	// The sibling resolved a Worker environment named after the generated
	// config's worker name ('handoff-proof' → 'handoff_proof') even though no
	// authored wrangler.* exists — it can only have read the generated file.
	expect(Object.keys(environments)).toContain('handoff_proof');

	// The generated inputs exist and carry Flue's contributions.
	const generatedWranglerPath = path.join(root, '.flue-vite.wrangler.jsonc');
	expect(process.env.CLOUDFLARE_VITE_WRANGLER_CONFIG_PATH).toBe(generatedWranglerPath);
	const generated = JSON.parse(fs.readFileSync(generatedWranglerPath, 'utf8')) as {
		name: string;
		main: string;
		compatibility_flags: string[];
		durable_objects: { bindings: Array<{ name: string; class_name: string }> };
	};
	expect(generated.name).toBe('handoff-proof');
	expect(generated.main).toBe('.flue-vite/_entry.ts');
	expect(generated.compatibility_flags).toContain('nodejs_compat');
	expect(generated.durable_objects.bindings).toEqual([
		{ name: 'FLUE_ECHO_AGENT', class_name: 'FlueEchoAgent' },
	]);
	const entry = fs.readFileSync(path.join(root, '.flue-vite', '_entry.ts'), 'utf8');
	expect(entry).toContain('export const FlueEchoAgent = createFlueAgentClass({');

	if (api) {
		expect(api.resolved?.target).toBe('cloudflare');
		expect(api.resolved?.agents.map((agent) => agent.identity)).toEqual(['echo']);
	}
}

describe('wrangler config handoff to the sibling cloudflare() plugin', () => {
	it('hands off when invoked from the project directory (root = cwd)', async () => {
		const root = handoffProjectRoot();
		const plugins = flue();
		process.chdir(root);
		const resolved = await resolveConfig(
			{ configFile: false, logLevel: 'error', plugins: [plugins, cloudflare()] },
			'serve',
		);
		expectHandoff({ root, environments: resolved.environments, api: flueApiOf(plugins) });
	});

	it('hands off with a positional root (vite dev <root>)', async () => {
		const root = handoffProjectRoot();
		const plugins = flue();
		const resolved = await resolveConfig(
			{ root, configFile: false, logLevel: 'error', plugins: [plugins, cloudflare()] },
			'serve',
		);
		expectHandoff({ root, environments: resolved.environments, api: flueApiOf(plugins) });
	});

	it('hands off with an explicit vite --config path (published-package resolution)', async () => {
		const root = handoffProjectRoot();
		// The config file lives OUTSIDE the project root and imports the real
		// installed package shape: `@flue/vite` resolves through a node_modules
		// link to this package's dist build.
		fs.mkdirSync(path.join(root, 'node_modules', '@flue'), { recursive: true });
		fs.symlinkSync(PACKAGE_DIR, path.join(root, 'node_modules', '@flue', 'vite'), 'dir');
		const configPath = path.join(root, 'config', 'vite.custom.mts');
		fs.mkdirSync(path.dirname(configPath), { recursive: true });
		fs.writeFileSync(
			configPath,
			`import { cloudflare } from '@cloudflare/vite-plugin';
import { flue } from '@flue/vite';
export default { root: ${JSON.stringify(root)}, logLevel: 'error', plugins: [flue(), cloudflare()] };
`,
			'utf8',
		);
		process.chdir(root);
		const resolved = await resolveConfig({ configFile: configPath }, 'serve');
		expectHandoff({ root, environments: resolved.environments });
	});

	it('also hands off for the build command', async () => {
		const root = handoffProjectRoot();
		const plugins = flue();
		const resolved = await resolveConfig(
			{ root, configFile: false, logLevel: 'error', plugins: [plugins, cloudflare()] },
			'build',
		);
		expectHandoff({ root, environments: resolved.environments, api: flueApiOf(plugins) });
	});

	it('merges an authored wrangler.jsonc: user name and migrations pass through, bindings are added', async () => {
		const root = handoffProjectRoot();
		fs.writeFileSync(
			path.join(root, 'wrangler.jsonc'),
			cloudflareWranglerJson({
				name: 'authored-name',
				migrations: [{ tag: 'v1', new_sqlite_classes: ['FlueEchoAgent'] }],
				vars: { CUSTOM: 'kept' },
			}),
		);
		const resolved = await resolveConfig(
			{ root, configFile: false, logLevel: 'error', plugins: [flue(), cloudflare()] },
			'serve',
		);
		expect(Object.keys(resolved.environments)).toContain('authored_name');
		const generated = JSON.parse(
			fs.readFileSync(path.join(root, '.flue-vite.wrangler.jsonc'), 'utf8'),
		) as Record<string, unknown>;
		expect(generated.name).toBe('authored-name');
		expect(generated.main).toBe('.flue-vite/_entry.ts');
		expect(generated.migrations).toEqual([{ tag: 'v1', new_sqlite_classes: ['FlueEchoAgent'] }]);
		expect(generated.vars).toEqual({ CUSTOM: 'kept' });
		expect(generated.durable_objects).toEqual({
			bindings: [{ name: 'FLUE_ECHO_AGENT', class_name: 'FlueEchoAgent' }],
		});
	});
});

describe('sibling diagnostics', () => {
	it('rejects flue() placed after cloudflare()', async () => {
		const root = handoffProjectRoot();
		await expect(
			resolveConfig(
				{ root, configFile: false, logLevel: 'error', plugins: [cloudflare(), flue()] },
				'serve',
			),
		).rejects.toThrow('flue() must come before cloudflare() in the Vite plugins array');
	});

	it('rejects an explicit cloudflare target without the sibling plugin', async () => {
		const root = handoffProjectRoot();
		await expect(
			resolveConfig(
				{
					root,
					configFile: false,
					logLevel: 'error',
					plugins: [flue({ target: 'cloudflare' })],
				},
				'serve',
			),
		).rejects.toThrow('@cloudflare/vite-plugin is not in the Vite plugin array');
	});

	it('rejects db.ts on the cloudflare target with the legacy-parity diagnostic', async () => {
		const root = handoffProjectRoot();
		fs.writeFileSync(path.join(root, 'src', 'db.ts'), 'export default undefined;\n');
		await expect(
			resolveConfig(
				{ root, configFile: false, logLevel: 'error', plugins: [flue(), cloudflare()] },
				'serve',
			),
		).rejects.toThrow('Custom persistence (db.ts) is not supported on the Cloudflare target');
	});

	it('rejects an authored wrangler config that fails Flue validation, without writing generated inputs', async () => {
		const root = handoffProjectRoot();
		fs.writeFileSync(
			path.join(root, 'wrangler.jsonc'),
			`${JSON.stringify(
				{
					name: 'too-old',
					compatibility_date: '2024-01-01',
					compatibility_flags: ['nodejs_compat'],
				},
				null,
				2,
			)}\n`,
		);
		await expect(
			resolveConfig(
				{ root, configFile: false, logLevel: 'error', plugins: [flue(), cloudflare()] },
				'serve',
			),
		).rejects.toThrow('Flue requires at least');
		expect(fs.existsSync(path.join(root, '.flue-vite.wrangler.jsonc'))).toBe(false);
	});
});
