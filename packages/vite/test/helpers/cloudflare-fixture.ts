/**
 * Cloudflare-target project fixtures for the `flue()` + `cloudflare()`
 * sibling integration tests.
 *
 * The offline fake-model pattern differs from the Node fixtures: workerd has
 * no `node:http` server, so the fake OpenAI-completions endpoint runs in the
 * TEST process ({@link startFakeModelServer}) and the fixture's
 * `src/test-model.ts` only registers a provider pointing at it — worker
 * outbound `fetch` reaches the loopback listener.
 */
import { createServer, type Server } from 'node:http';

export interface FakeModelServer {
	readonly port: number;
	close(): Promise<void>;
}

/**
 * A fake OpenAI-completions SSE endpoint (mirrors the runtime's
 * providers.test.ts response shape), listening on a loopback port in the test
 * process.
 */
export async function startFakeModelServer(): Promise<FakeModelServer> {
	const server: Server = createServer((req, res) => {
		req.resume();
		req.on('end', () => {
			const chunk = (data: unknown) => `data: ${JSON.stringify(data)}\n\n`;
			res.writeHead(200, { 'content-type': 'text/event-stream' });
			res.end(
				[
					chunk({
						id: 'chunk-1',
						object: 'chat.completion.chunk',
						created: 1,
						choices: [
							{
								index: 0,
								delta: { role: 'assistant', content: 'Hello from the fake model.' },
								finish_reason: null,
							},
						],
					}),
					chunk({
						id: 'chunk-1',
						object: 'chat.completion.chunk',
						created: 1,
						choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
						usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
					}),
					'data: [DONE]\n\n',
				].join(''),
			);
		});
	});
	await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
	const address = server.address();
	if (typeof address !== 'object' || !address) throw new Error('No fake-model port assigned.');
	return {
		port: address.port,
		close: () =>
			new Promise<void>((resolve, reject) => {
				server.closeAllConnections();
				server.close((error) => (error ? reject(error) : resolve()));
			}),
	};
}

/** Provider registration module pointing at the test-process fake model. */
export function cloudflareTestModelModule(modelPort: number): string {
	return `import { registerProvider } from '@flue/runtime';

registerProvider('flue-test', {
	api: 'openai-completions',
	baseUrl: 'http://127.0.0.1:${modelPort}/v1',
	apiKey: 'test-key',
});
`;
}

export const CF_ECHO_AGENT_MODULE = `'use agent';
import { defineAgent } from '@flue/runtime';
export default defineAgent(() => ({ model: 'flue-test/fake-model' }));
export const description = 'Echo agent';
`;

const CF_BASIC_APP_MODULE = `import { Hono } from 'hono';
import './test-model.ts';
import echo from './agents/echo.ts';

const app = new Hono();
app.get('/api/ping', (c) => c.text('pong'));
app.route('/agents/echo', echo.route());

export default app;
`;

export interface CloudflareWranglerOptions {
	name?: string;
	migrations?: unknown[];
	[key: string]: unknown;
}

/** A user-authored wrangler.jsonc meeting Flue's compat floor. */
export function cloudflareWranglerJson(options: CloudflareWranglerOptions = {}): string {
	const { name = 'flue-cf-fixture', migrations, ...rest } = options;
	return `${JSON.stringify(
		{
			name,
			compatibility_date: '2026-06-01',
			compatibility_flags: ['nodejs_compat'],
			...(migrations !== undefined ? { migrations } : {}),
			...rest,
		},
		null,
		2,
	)}\n`;
}

/** A minimal runnable Cloudflare project: one mounted agent + one custom route. */
export function basicCloudflareProjectFiles(options: {
	modelPort: number;
	wranglerName?: string;
}): Record<string, string> {
	return {
		'wrangler.jsonc': cloudflareWranglerJson({
			name: options.wranglerName ?? 'flue-cf-fixture',
			migrations: [{ tag: 'v1', new_sqlite_classes: ['FlueEchoAgent'] }],
		}),
		'src/test-model.ts': cloudflareTestModelModule(options.modelPort),
		'src/agents/echo.ts': CF_ECHO_AGENT_MODULE,
		'src/app.ts': CF_BASIC_APP_MODULE,
	};
}
