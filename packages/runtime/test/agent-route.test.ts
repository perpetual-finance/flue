import { Hono } from 'hono';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { useModel } from '../src/hooks/use-model.ts';
import { configureFlueRuntime, resetFlueRuntimeForTests } from '../src/runtime/flue-app.ts';
import {
	__flueBindAgentModule,
	createAgentRouter,
	registerFlueAgents,
	resetFlueAgentRegistrationForTests,
} from '../src/runtime/registration.ts';
import type { Agent } from '../src/types.ts';
import { cloudflareRuntime, nodeRuntime } from './helpers/runtime-config.ts';

afterEach(() => {
	resetFlueRuntimeForTests();
	resetFlueAgentRegistrationForTests();
});

function boundAgent(identity = 'triage'): Agent {
	const agent = () => {
		useModel('anthropic/claude-haiku-4-5');
	};
	__flueBindAgentModule(agent, { identity });
	return agent;
}

function promptRequest(url: string): Request {
	return new Request(url, {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({ kind: 'user', body: 'hello' }),
	});
}

describe('createAgentRouter()', () => {
	it('throws an identity hint when the agent has no binding, static, or name', () => {
		// Passed inline (not bound to a variable), so the function has no
		// inferred `.name` either — genuinely anonymous.
		expect(() =>
			createAgentRouter(() => {
				useModel('anthropic/claude-haiku-4-5');
			}),
		).toThrow('could not resolve an identity');
	});

	it('is a pure factory: safe to call repeatedly and mount at several paths', async () => {
		const agent = boundAgent();
		const createAgentAdmission = vi.fn((_agentName: string, _id: string) => async () => ({
			submissionId: 'submission-1',
			offset: '-1',
		}));
		configureFlueRuntime(
			nodeRuntime({
				createAgentAdmission,
			}),
		);

		const app = new Hono();
		app.route('/agents/triage', createAgentRouter(agent));
		app.route('/other/mount', createAgentRouter(agent));

		const first = await app.fetch(promptRequest('http://localhost/agents/triage/cust-1'));
		const second = await app.fetch(promptRequest('http://localhost/other/mount/cust-1'));

		expect(first.status).toBe(202);
		expect(second.status).toBe(202);
		// Both mounts drive the same storage identity — the module identity, not
		// the mount path.
		expect(createAgentAdmission).toHaveBeenNthCalledWith(1, 'triage', 'cust-1');
		expect(createAgentAdmission).toHaveBeenNthCalledWith(2, 'triage', 'cust-1');
	});

	it('admits a prompt with stream coordinates derived from the mount URL', async () => {
		const agent = boundAgent();
		configureFlueRuntime(
			nodeRuntime({
				createAgentAdmission: () => async () => ({ submissionId: 'submission-1', offset: '-1' }),
			}),
		);
		const app = new Hono();
		app.route('/api/agents/triage', createAgentRouter(agent));

		const response = await app.fetch(promptRequest('http://localhost/api/agents/triage/cust-1'));

		expect(response.status).toBe(202);
		expect(await response.json()).toEqual({
			streamUrl: 'http://localhost/api/agents/triage/cust-1',
			offset: '-1',
			submissionId: 'submission-1',
		});
		expect(response.headers.get('location')).toBe('http://localhost/api/agents/triage/cust-1');
		expect(response.headers.get('stream-next-offset')).toBe('-1');
	});

	it('serves an agent registered by the bootstrap without a module binding', async () => {
		const agent = () => {
			useModel('anthropic/claude-haiku-4-5');
		};
		registerFlueAgents([{ agent, identity: 'support' }]);
		const createAgentAdmission = vi.fn((_agentName: string, _id: string) => async () => ({
			submissionId: 'submission-1',
			offset: '-1',
		}));
		configureFlueRuntime(
			nodeRuntime({ createAgentAdmission }),
		);
		const app = new Hono();
		app.route('/agents/support', createAgentRouter(agent));

		const response = await app.fetch(promptRequest('http://localhost/agents/support/cust-9'));

		expect(response.status).toBe(202);
		expect(createAgentAdmission).toHaveBeenCalledWith('support', 'cust-9');
	});

	it('rejects the agent-prompt wait query with the canonical invalid_request envelope', async () => {
		const agent = boundAgent();
		configureFlueRuntime(
			nodeRuntime({
				createAgentAdmission: () => async () => ({ submissionId: 'submission-1', offset: '-1' }),
			}),
		);
		const app = new Hono();
		app.route('/agents/triage', createAgentRouter(agent));

		const response = await app.fetch(
			promptRequest('http://localhost/agents/triage/cust-1?wait=result'),
		);

		expect(response.status).toBe(400);
		const body = (await response.json()) as { error: { type: string } };
		expect(body.error.type).toBe('invalid_request');
	});

	it('renders invalid_request for a mistyped wait value via the query validator', async () => {
		const agent = boundAgent();
		configureFlueRuntime(nodeRuntime());
		const app = new Hono();
		app.route('/agents/triage', createAgentRouter(agent));

		const response = await app.fetch(
			promptRequest('http://localhost/agents/triage/cust-1?wait=results'),
		);

		expect(response.status).toBe(400);
		const body = (await response.json()) as { error: { type: string } };
		expect(body.error.type).toBe('invalid_request');
	});

	it('returns stream_not_found for a conversation read before any admitted prompt', async () => {
		const agent = boundAgent();
		configureFlueRuntime(nodeRuntime());
		const app = new Hono();
		app.route('/agents/triage', createAgentRouter(agent));

		const response = await app.fetch(new Request('http://localhost/agents/triage/cust-1'));

		expect(response.status).toBe(404);
		const body = (await response.json()) as { error: { type: string } };
		expect(body.error.type).toBe('stream_not_found');
	});

	it('rejects unsupported methods with the canonical 405 envelope', async () => {
		const agent = boundAgent();
		configureFlueRuntime(nodeRuntime());
		const app = new Hono();
		app.route('/agents/triage', createAgentRouter(agent));

		const response = await app.fetch(
			new Request('http://localhost/agents/triage/cust-1', { method: 'DELETE' }),
		);

		expect(response.status).toBe(405);
		expect(response.headers.get('allow')).toBe('GET, HEAD, POST');
		expect(await response.json()).toEqual({
			error: {
				type: 'method_not_allowed',
				message: 'HTTP method DELETE is not allowed on this endpoint.',
				details: 'This endpoint accepts "GET", "HEAD", "POST" only.',
			},
		});
	});

	it('rejects a whitespace-only conversation id segment', async () => {
		const agent = boundAgent();
		configureFlueRuntime(nodeRuntime());
		const app = new Hono();
		app.route('/agents/triage', createAgentRouter(agent));

		const response = await app.fetch(promptRequest('http://localhost/agents/triage/%20'));

		expect(response.status).toBe(400);
		const body = (await response.json()) as { error: { type: string } };
		expect(body.error.type).toBe('invalid_request');
	});

	it('aborts an instance over POST /:id/abort and rejects other methods', async () => {
		const agent = boundAgent();
		const abortAgentInstance = vi.fn(async (_name: string, _id: string) => true);
		configureFlueRuntime(nodeRuntime({ abortAgentInstance }));
		const app = new Hono();
		app.route('/agents/triage', createAgentRouter(agent));

		const aborted = await app.fetch(
			new Request('http://localhost/agents/triage/cust-1/abort', { method: 'POST' }),
		);
		expect(aborted.status).toBe(200);
		expect(await aborted.json()).toEqual({ aborted: true });
		expect(abortAgentInstance).toHaveBeenCalledWith('triage', 'cust-1');

		const wrongMethod = await app.fetch(
			new Request('http://localhost/agents/triage/cust-1/abort'),
		);
		expect(wrongMethod.status).toBe(405);
		expect(wrongMethod.headers.get('allow')).toBe('POST');
	});

	describe('attachments route', () => {
		it('serves the download endpoint on every mounted agent, no export required', async () => {
			const agent = boundAgent();
			configureFlueRuntime(nodeRuntime());
			const app = new Hono();
			app.route('/agents/triage', createAgentRouter(agent));

			// No stream exists yet, so the byte handler reports a missing
			// stream — proof the endpoint exists without any opt-in.
			const response = await app.fetch(
				new Request('http://localhost/agents/triage/inst-1/attachments/att-1'),
			);

			expect(response.status).toBe(404);
			const body = (await response.json()) as { error: { type: string } };
			expect(body.error.type).toBe('stream_not_found');
		});

		it('rejects non-GET methods on the attachments route', async () => {
			const agent = boundAgent();
			configureFlueRuntime(nodeRuntime());
			const app = new Hono();
			app.route('/agents/triage', createAgentRouter(agent));

			const response = await app.fetch(
				new Request('http://localhost/agents/triage/inst-1/attachments/att-1', {
					method: 'POST',
				}),
			);

			expect(response.status).toBe(405);
			expect(response.headers.get('allow')).toBe('GET');
		});
	});

	describe('cloudflare target', () => {
		it('forwards prompt, read, abort, and attachment requests to the agent DO by identity', async () => {
			const agent = boundAgent();
			const routeAgentRequest = vi.fn(
				async (
					_request: Request,
					_env: unknown,
					_target: { agentName: string; instanceId: string },
				) => new Response('forwarded'),
			);
			configureFlueRuntime(cloudflareRuntime({ routeAgentRequest }));
			const app = new Hono();
			app.route('/agents/triage', createAgentRouter(agent));

			const urls = [
				promptRequest('http://localhost/agents/triage/cust-1'),
				new Request('http://localhost/agents/triage/cust-1'),
				new Request('http://localhost/agents/triage/cust-1/abort', { method: 'POST' }),
				new Request('http://localhost/agents/triage/cust-1/attachments/att-1'),
			];
			for (const request of urls) {
				const response = await app.fetch(request);
				expect(response.status).toBe(200);
				expect(await response.text()).toBe('forwarded');
			}

			expect(routeAgentRequest).toHaveBeenCalledTimes(4);
			for (const call of routeAgentRequest.mock.calls) {
				expect(call[2]).toEqual({ agentName: 'triage', instanceId: 'cust-1' });
			}
		});

		it('forwards abort and attachment requests on the canonical identity path, whatever the mount', async () => {
			// The DO coordinator recognizes abort/attachment intent by the
			// `/agents/<identity>/<id>` URL tail; the public mount path is
			// user-chosen and must not leak into the DO-bound request.
			const agent = boundAgent('support-desk');
			const forwarded: Array<{ method: string; pathname: string }> = [];
			const routeAgentRequest = vi.fn(
				async (
					request: Request,
					_env: unknown,
					_target: { agentName: string; instanceId: string },
				) => {
					forwarded.push({ method: request.method, pathname: new URL(request.url).pathname });
					return new Response('forwarded');
				},
			);
			configureFlueRuntime(cloudflareRuntime({ routeAgentRequest }));
			const app = new Hono();
			app.route('/api/assistants/desk', createAgentRouter(agent));

			const abort = await app.fetch(
				new Request('http://localhost/api/assistants/desk/case%3A8472/abort', {
					method: 'POST',
				}),
			);
			expect(abort.status).toBe(200);
			const attachment = await app.fetch(
				new Request('http://localhost/api/assistants/desk/case%3A8472/attachments/att-1'),
			);
			expect(attachment.status).toBe(200);

			expect(forwarded).toEqual([
				{ method: 'POST', pathname: '/agents/support-desk/case%3A8472/abort' },
				{ method: 'GET', pathname: '/agents/support-desk/case%3A8472/attachments/att-1' },
			]);
			for (const call of routeAgentRequest.mock.calls) {
				expect(call[2]).toEqual({ agentName: 'support-desk', instanceId: 'case:8472' });
			}
		});

		it('renders route_not_found when no DO matches the forwarded request', async () => {
			const agent = boundAgent();
			configureFlueRuntime(cloudflareRuntime({ routeAgentRequest: async () => null }));
			const app = new Hono();
			app.route('/agents/triage', createAgentRouter(agent));

			const response = await app.fetch(promptRequest('http://localhost/agents/triage/cust-1'));

			expect(response.status).toBe(404);
			const body = (await response.json()) as { error: { type: string } };
			expect(body.error.type).toBe('route_not_found');
		});
	});
});
