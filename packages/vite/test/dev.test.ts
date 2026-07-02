import { createLogger, createServer, type ViteDevServer } from 'vite';
import { afterEach, describe, expect, it } from 'vitest';
import { flue } from '../src/index.ts';
import {
	BASIC_APP_MODULE,
	basicNodeProjectFiles,
	createFixture,
	ECHO_AGENT_MODULE,
	type Fixture,
	getAvailablePort,
	readStreamUntil,
	waitFor,
} from './helpers/fixture.ts';

const fixtures: Fixture[] = [];
const servers: ViteDevServer[] = [];

afterEach(async () => {
	for (const server of servers.splice(0)) {
		await server.close().catch(() => undefined);
	}
	for (const fixture of fixtures.splice(0)) fixture.cleanup();
});

function fixtureOf(files: Record<string, string>): Fixture {
	const fixture = createFixture(files);
	fixtures.push(fixture);
	return fixture;
}

async function startDev(fixture: Fixture) {
	const port = await getAvailablePort();
	const errors: string[] = [];
	const logger = createLogger('error', { allowClearScreen: false });
	const baseError = logger.error.bind(logger);
	logger.error = (message, options) => {
		errors.push(String(message));
		baseError(message, options);
	};
	const server = await createServer({
		root: fixture.root,
		configFile: false,
		logLevel: 'error',
		customLogger: logger,
		plugins: flue(),
		server: { port, strictPort: true, host: '127.0.0.1' },
	});
	await server.listen();
	servers.push(server);
	const baseUrl = `http://127.0.0.1:${port}`;
	// The application loads asynchronously behind the 503 admission gate.
	await waitFor(
		async () => {
			const response = await fetch(`${baseUrl}/api/ping`);
			return response.ok;
		},
		{ description: `dev application to become ready (errors: ${errors.join('; ')})` },
	);
	return { server, baseUrl, errors };
}

async function promptAdmits(baseUrl: string, mount: string, id: string, body: string) {
	return fetch(`${baseUrl}${mount}/${id}`, {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({ kind: 'user', body }),
	});
}

describe('vite dev (node target)', () => {
	it('serves the app, streams a conversation, hot-reloads edits, and picks up new agents', async () => {
		const fixture = fixtureOf(basicNodeProjectFiles());
		const { server, baseUrl, errors } = await startDev(fixture);

		// Initial request works.
		const ping = await fetch(`${baseUrl}/api/ping`);
		expect(await ping.text()).toBe('pong');

		// Prompt admission + streamed conversation read through the dev
		// middleware (offline fake provider produces the assistant turn).
		const admitted = await promptAdmits(baseUrl, '/agents/echo', 'dev-1', 'hi from dev');
		expect(admitted.status).toBe(202);
		const streamed = await waitFor(
			async () => {
				const stream = await fetch(`${baseUrl}/agents/echo/dev-1`);
				if (stream.status !== 200) return false;
				return readStreamUntil(stream, (text) => text.includes('Hello from the fake model.'));
			},
			{ description: 'the assistant reply in the dev conversation stream' },
		);
		expect(streamed).toContain('hi from dev');

		// Body edit hot path: the app module reloads (load-new-then-stop-old).
		fixture.write('src/app.ts', BASIC_APP_MODULE.replace(`c.text('pong')`, `c.text('pong-v2')`));
		await waitFor(async () => (await (await fetch(`${baseUrl}/api/ping`)).text()) === 'pong-v2', {
			description: 'the edited app module to serve',
		});

		// Conversation history survived the reload (dev SQLite file).
		const history = await fetch(`${baseUrl}/agents/echo/dev-1`);
		expect(history.status).toBe(200);
		await readStreamUntil(history, (text) => text.includes('hi from dev'));

		// Agent add: a new 'use agent' file joins the marked set and its mount
		// admits prompts after the watcher-driven regeneration.
		fixture.write('src/agents/writer.ts', ECHO_AGENT_MODULE);
		fixture.write(
			'src/app.ts',
			[
				`import { Hono } from 'hono';`,
				`import './test-model.ts';`,
				`import echo from './agents/echo.ts';`,
				`import writer from './agents/writer.ts';`,
				`const app = new Hono();`,
				`app.get('/api/ping', (c) => c.text('pong-v3'));`,
				`app.route('/agents/echo', echo.route());`,
				`app.route('/agents/writer', writer.route());`,
				`export default app;`,
				'',
			].join('\n'),
		);
		await waitFor(
			async () => {
				const response = await promptAdmits(baseUrl, '/agents/writer', 'dev-2', 'hello writer');
				return response.status === 202;
			},
			{ description: `the added agent to admit prompts (errors: ${errors.join('; ')})` },
		);

		// Syntax error: the reload fails, the previous application keeps
		// serving, and the failure is surfaced through the logger.
		const errorCount = errors.length;
		fixture.write('src/app.ts', `import { Hono } from 'hono';\nconst app = new Hono(;\n`);
		await waitFor(() => errors.length > errorCount, {
			description: 'the failed reload to be logged',
		});
		expect(errors.slice(errorCount).join('\n')).toContain('[flue] Application load failed');
		const stale = await fetch(`${baseUrl}/api/ping`);
		expect(stale.status).toBe(200);

		// Recover on the next edit.
		fixture.write(
			'src/app.ts',
			BASIC_APP_MODULE.replace(`c.text('pong')`, `c.text('pong-recovered')`),
		);
		await waitFor(
			async () => (await (await fetch(`${baseUrl}/api/ping`)).text()) === 'pong-recovered',
			{ description: 'the dev server to recover after the syntax error' },
		);

		// Clean shutdown: close() resolves and the listener is gone.
		await server.close();
		await expect(fetch(`${baseUrl}/api/ping`)).rejects.toThrow();
	}, 120_000);

	it('renders the canonical 503 envelope while the application is loading or failed', async () => {
		// An app whose module evaluation fails: the middleware must answer with
		// the runtime_unavailable envelope rather than hanging or crashing.
		const files = basicNodeProjectFiles();
		const fixture = fixtureOf({
			...files,
			'src/app.ts': `throw new Error('boom at load time');\nexport default { fetch: () => new Response('nope') };\n`,
		});
		const port = await getAvailablePort();
		const server = await createServer({
			root: fixture.root,
			configFile: false,
			logLevel: 'silent',
			plugins: flue(),
			server: { port, strictPort: true, host: '127.0.0.1' },
		});
		await server.listen();
		servers.push(server);
		const baseUrl = `http://127.0.0.1:${port}`;
		const response = await waitFor(
			async () => {
				const result = await fetch(`${baseUrl}/api/ping`);
				return result.status === 503 ? result : false;
			},
			{ description: 'the unavailable envelope' },
		);
		const body = (await response.json()) as { error: { type: string } };
		expect(body.error.type).toBe('runtime_unavailable');
	}, 60_000);

	it('fails fast with the app.ts starter diagnostic when no app entry exists', async () => {
		const fixture = fixtureOf({ 'src/agents/echo.ts': ECHO_AGENT_MODULE });
		await expect(
			createServer({ root: fixture.root, configFile: false, logLevel: 'silent', plugins: flue() }),
		).rejects.toThrow(/No app entry found/);
	});

	it('warns about enforced Vite config overrides and ambiguous flue.config files', async () => {
		const fixture = fixtureOf({
			...basicNodeProjectFiles(),
			'flue.config.ts': `export default {};\n`,
			'flue.config.js': `export default {};\n`,
		});
		const warnings: string[] = [];
		const logger = createLogger('warn', { allowClearScreen: false });
		const baseWarn = logger.warn.bind(logger);
		logger.warn = (message, options) => {
			warnings.push(String(message));
			baseWarn(message, options);
		};
		const server = await createServer({
			root: fixture.root,
			configFile: false,
			logLevel: 'warn',
			customLogger: logger,
			// User-set appType conflicts with the value flue() enforces.
			appType: 'spa',
			plugins: flue(),
		});
		servers.push(server);
		const joined = warnings.join('\n');
		expect(joined).toContain('overridden by flue()');
		expect(joined).toContain('appType');
		expect(joined).toContain('Multiple Flue config files');
		expect(joined).toContain('using flue.config.ts');
	});

	it('restarts the dev server when flue.config appears or changes', async () => {
		const fixture = fixtureOf({
			...basicNodeProjectFiles(),
			'src/other-app.ts': BASIC_APP_MODULE.replace(`c.text('pong')`, `c.text('pong-from-config')`),
		});
		const { baseUrl } = await startDev(fixture);

		// Creating a flue.config.ts at the root restarts and re-resolves the
		// project (the config points `app` at a different entry).
		fixture.write('flue.config.ts', `export default { app: './src/other-app.ts' };\n`);
		await waitFor(
			async () => (await (await fetch(`${baseUrl}/api/ping`)).text()) === 'pong-from-config',
			{ description: 'the dev server to restart onto the configured app entry' },
		);

		// Removing the discovered config restarts again, back onto the default
		// lookup. (Config-content EDITS also restart through the same path; the
		// freshness of the re-imported module is loadFlueConfig's contract and
		// isn't assertable under vitest, whose ESM loader cache ignores the
		// import query used for cache busting. Verified manually under plain
		// Node.)
		fixture.remove('flue.config.ts');
		await waitFor(async () => (await (await fetch(`${baseUrl}/api/ping`)).text()) === 'pong', {
			description: 'the dev server to restart back onto the default app entry',
		});
	}, 120_000);
});
