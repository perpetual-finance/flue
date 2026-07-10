/**
 * Temporary project fixtures for the `flue()` integration tests.
 *
 * Fixtures live under `test/.tmp/` (inside the package, NOT the OS tmpdir) so
 * their bare imports (`@flue/runtime`, `hono`) resolve through
 * `packages/vite/node_modules` like a real project's would.
 */
import * as fs from 'node:fs';
import * as net from 'node:net';
import * as path from 'node:path';

const TMP_ROOT = path.join(import.meta.dirname, '..', '.tmp');

export interface Fixture {
	readonly root: string;
	write(relPath: string, content: string): void;
	remove(relPath: string): void;
	cleanup(): void;
}

export function createFixture(files: Record<string, string>): Fixture {
	fs.mkdirSync(TMP_ROOT, { recursive: true });
	const root = fs.mkdtempSync(path.join(TMP_ROOT, 'fixture-'));
	const fixture: Fixture = {
		root,
		write(relPath, content) {
			const filePath = path.join(root, relPath);
			fs.mkdirSync(path.dirname(filePath), { recursive: true });
			fs.writeFileSync(filePath, content, 'utf8');
		},
		remove(relPath) {
			fs.rmSync(path.join(root, relPath), { force: true, recursive: true });
		},
		cleanup() {
			fs.rmSync(root, { recursive: true, force: true });
		},
	};
	for (const [relPath, content] of Object.entries(files)) fixture.write(relPath, content);
	return fixture;
}

/**
 * A fake OpenAI-completions provider served from inside the fixture app's own
 * process. `src/test-model.ts` starts a local SSE endpoint and registers it
 * as the `flue-test` provider, so agent turns run the real model pipeline
 * fully offline (mirrors the runtime's providers.test.ts response shape).
 */
export const TEST_MODEL_MODULE = `
import { createServer } from 'node:http';
import { registerProvider } from '@flue/runtime';

const server = createServer((req, res) => {
	req.resume();
	req.on('end', () => {
		const chunk = (data) => 'data: ' + JSON.stringify(data) + '\\n\\n';
		res.writeHead(200, { 'content-type': 'text/event-stream' });
		res.end(
			[
				chunk({
					id: 'chunk-1',
					object: 'chat.completion.chunk',
					created: 1,
					choices: [
						{ index: 0, delta: { role: 'assistant', content: 'Hello from the fake model.' }, finish_reason: null },
					],
				}),
				chunk({
					id: 'chunk-1',
					object: 'chat.completion.chunk',
					created: 1,
					choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
					usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
				}),
				'data: [DONE]\\n\\n',
			].join(''),
		);
	});
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
server.unref();
const { port } = server.address();
registerProvider('flue-test', {
	api: 'openai-completions',
	baseUrl: 'http://127.0.0.1:' + port + '/v1',
	apiKey: 'test-key',
});
`;

export const ECHO_AGENT_MODULE = `'use agent';
import { defineAgent, useModel } from '@flue/runtime';
export default defineAgent(() => {
	useModel('flue-test/fake-model');
});
export const description = 'Echo agent';
`;

export const BASIC_APP_MODULE = `import { Hono } from 'hono';
import './test-model.ts';
import echo from './agents/echo.ts';

const app = new Hono();
app.get('/api/ping', (c) => c.text('pong'));
app.route('/agents/echo', echo.route());

export default app;
`;

/** A minimal runnable Node project: one mounted agent + one custom route. */
export function basicNodeProjectFiles(): Record<string, string> {
	return {
		'src/test-model.ts': TEST_MODEL_MODULE,
		'src/agents/echo.ts': ECHO_AGENT_MODULE,
		'src/app.ts': BASIC_APP_MODULE,
	};
}

export function getAvailablePort(): Promise<number> {
	return new Promise((resolve, reject) => {
		const server = net.createServer();
		server.once('error', reject);
		server.listen(0, '127.0.0.1', () => {
			const address = server.address();
			const port = typeof address === 'object' && address ? address.port : undefined;
			server.close(() => {
				if (port) resolve(port);
				else reject(new Error('No port assigned.'));
			});
		});
	});
}

export interface WaitForOptions {
	timeoutMs?: number;
	intervalMs?: number;
	description?: string;
}

/** Poll `probe` until it resolves truthy; rejects on timeout. */
export async function waitFor<T>(
	probe: () => Promise<T | undefined | false> | T | undefined | false,
	options: WaitForOptions = {},
): Promise<T> {
	const timeoutMs = options.timeoutMs ?? 30_000;
	const intervalMs = options.intervalMs ?? 100;
	const deadline = Date.now() + timeoutMs;
	let lastError: unknown;
	while (Date.now() < deadline) {
		try {
			const result = await probe();
			if (result) return result;
		} catch (error) {
			lastError = error;
		}
		await new Promise((resolve) => setTimeout(resolve, intervalMs));
	}
	throw new Error(
		`Timed out waiting for ${options.description ?? 'condition'} after ${timeoutMs}ms.` +
			(lastError
				? ` Last error: ${lastError instanceof Error ? lastError.message : lastError}`
				: ''),
	);
}

/** Read a streamed response body until `predicate` matches; then cancel. */
export async function readStreamUntil(
	response: Response,
	predicate: (bodyText: string) => boolean,
	timeoutMs = 30_000,
): Promise<string> {
	if (!response.body) throw new Error('Response has no body to read.');
	const reader = response.body.getReader();
	const decoder = new TextDecoder();
	let text = '';
	const deadline = Date.now() + timeoutMs;
	try {
		while (Date.now() < deadline) {
			const race = await Promise.race([
				reader.read(),
				new Promise<'timeout'>((resolve) =>
					setTimeout(() => resolve('timeout'), Math.max(deadline - Date.now(), 0)),
				),
			]);
			if (race === 'timeout') break;
			if (race.done) break;
			text += decoder.decode(race.value, { stream: true });
			if (predicate(text)) return text;
		}
	} finally {
		await reader.cancel().catch(() => undefined);
	}
	if (predicate(text)) return text;
	throw new Error(`Timed out reading stream. Received so far:\n${text.slice(-2000)}`);
}
