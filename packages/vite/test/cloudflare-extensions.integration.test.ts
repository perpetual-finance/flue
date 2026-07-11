/**
 * Cloudflare deployment extensions through the direct-plugin path — parity
 * with the CLI's workerd integration suite
 * (packages/cli/test/cloudflare-deployment-extension.integration.test.ts):
 * authored Durable Objects and non-HTTP Worker handlers compose through
 * `cloudflare.ts`, and the generated entry's runtime validation rejects the
 * shapes Flue reserves.
 */
import * as path from 'node:path';
import { cloudflare } from '@cloudflare/vite-plugin';
import { createServer, type ViteDevServer } from 'vite';
import { afterEach, describe, expect, it } from 'vitest';
import { flue } from '../src/index.ts';
import {
	CF_ECHO_AGENT_MODULE,
	cloudflareTestModelModule,
	cloudflareWranglerJson,
} from './helpers/cloudflare-fixture.ts';
import { createFixture, type Fixture, getAvailablePort, waitFor } from './helpers/fixture.ts';

const fixtures: Fixture[] = [];
const servers: ViteDevServer[] = [];

afterEach(async () => {
	for (const server of servers.splice(0)) {
		await server.close().catch(() => undefined);
	}
	for (const fixture of fixtures.splice(0)) fixture.cleanup();
	delete process.env.CLOUDFLARE_VITE_WRANGLER_CONFIG_PATH;
});

const COUNTER_CLOUDFLARE_MODULE = `import { DurableObject } from 'cloudflare:workers';
export class Counter extends DurableObject {
	async increment() {
		const count = ((await this.ctx.storage.get('count')) ?? 0) + 1;
		await this.ctx.storage.put('count', count);
		return count;
	}
}
export default {
	async scheduled(_controller, env) {
		await env.Counter.getByName('default').increment();
	},
};
`;

function extensionFixture(cloudflareSource: string): Fixture {
	const fixture = createFixture({
		'wrangler.jsonc': cloudflareWranglerJson({
			name: 'flue-cf-extensions',
			durable_objects: { bindings: [{ name: 'Counter', class_name: 'Counter' }] },
			migrations: [
				{ tag: 'v1', new_sqlite_classes: ['FlueEchoAgent'] },
				{ tag: 'v2', new_sqlite_classes: ['Counter'] },
			],
		}),
		'src/test-model.ts': cloudflareTestModelModule(1),
		'src/agents/echo.ts': CF_ECHO_AGENT_MODULE,
		'src/cloudflare.ts': cloudflareSource,
		'src/app.ts': `import { Hono } from 'hono';
import { createAgentRouter } from '@flue/runtime/routing';
import './test-model.ts';
import { Echo } from './agents/echo.ts';

const app = new Hono();
app.get('/counter', async (c) => {
	const count = await c.env.Counter.getByName('default').increment();
	return c.json({ count });
});
app.route('/agents/echo', createAgentRouter(Echo));

export default app;
`,
	});
	fixtures.push(fixture);
	return fixture;
}

async function startDev(fixture: Fixture) {
	const port = await getAvailablePort();
	const server = await createServer({
		root: fixture.root,
		configFile: false,
		logLevel: 'error',
		// Per-fixture dep-optimizer cache: all fixtures here share a worker
		// name, and without their own node_modules they would otherwise share
		// `packages/vite/node_modules/.vite/deps_flue_cf_extensions` — which a
		// leaked server from a rejected createServer() (Vite does not dispose
		// the watcher/optimizer on configureServer failure) can rewrite under
		// the next test, making it reject with a missing-optimized-dep error.
		cacheDir: path.join(fixture.root, '.vite-cache'),
		plugins: [flue(), cloudflare({ persistState: false, inspectorPort: false })],
		server: { port, strictPort: true, host: '127.0.0.1' },
	});
	servers.push(server);
	await server.listen();
	return { server, baseUrl: `http://127.0.0.1:${port}` };
}

describe('Cloudflare deployment extensions (direct-plugin path)', () => {
	it('exports an authored Durable Object and composes non-HTTP Worker handlers', async () => {
		const fixture = extensionFixture(COUNTER_CLOUDFLARE_MODULE);
		const { baseUrl } = await startDev(fixture);

		const response = await waitFor(
			async () => {
				const result = await fetch(`${baseUrl}/counter`);
				return result.status === 200 ? result : false;
			},
			{ description: 'the authored Durable Object route', timeoutMs: 60_000 },
		);
		expect(await response.json()).toEqual({ count: 1 });

		// The authored `scheduled` handler survives the generated default
		// export spread (the sibling plugin exposes the trigger endpoint).
		const scheduled = await fetch(`${baseUrl}/cdn-cgi/handler/scheduled`);
		expect(scheduled.status).toBe(200);
		expect(await scheduled.text()).toBe('ok');
		const afterScheduled = await fetch(`${baseUrl}/counter`);
		expect(afterScheduled.status).toBe(200);
		expect(await afterScheduled.json()).toEqual({ count: 3 });
	}, 120_000);

	it('rejects fetch handlers authored in cloudflare.ts', async () => {
		const fixture = extensionFixture(
			`export class Counter {}\nexport default { async fetch() { return new Response('wrong'); } };\n`,
		);
		await expect(startDev(fixture)).rejects.toThrow(
			'cloudflare.ts default export must not define fetch. Use app.ts for custom HTTP handling.',
		);
	}, 120_000);

	it('rejects invalid cloudflare.ts default exports', async () => {
		const fixture = extensionFixture(`export class Counter {}\nexport default null;\n`);
		await expect(startDev(fixture)).rejects.toThrow(
			'cloudflare.ts default export must be an object containing non-HTTP Worker handlers.',
		);
	}, 120_000);

	it('rejects authored exports that conflict with generated Worker exports', async () => {
		const fixture = extensionFixture(`export class Counter {}\nexport class FlueEchoAgent {}\n`);
		await expect(startDev(fixture)).rejects.toThrow(
			'cloudflare.ts export "FlueEchoAgent" conflicts with a Flue-generated Worker export.',
		);
	}, 120_000);
});
