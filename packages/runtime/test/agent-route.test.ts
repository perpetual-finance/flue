import type { MiddlewareHandler } from 'hono';
import { Hono } from 'hono';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { defineAgent } from '../src/agent-definition.ts';
import { configureFlueRuntime, resetFlueRuntimeForTests } from '../src/runtime/flue-app.ts';
import {
	__flueBindAgentModule,
	registerFlueAgents,
	resetFlueAgentRegistrationForTests,
} from '../src/runtime/registration.ts';
import type { AgentDefinition } from '../src/types.ts';
import { cloudflareRuntime, nodeRuntime } from './helpers/runtime-config.ts';
import { createTestEventStreamStore } from './helpers/test-event-stream-store.ts';

afterEach(() => {
	resetFlueRuntimeForTests();
	resetFlueAgentRegistrationForTests();
});

function boundAgent(
	identity = 'triage',
	metadata: {
		route?: MiddlewareHandler;
		attachments?: MiddlewareHandler;
		description?: string;
	} = {},
): AgentDefinition {
	const agent = defineAgent(() => ({ model: 'anthropic/claude-haiku-4-5' }));
	__flueBindAgentModule(agent, { identity, ...metadata });
	return agent;
}

function promptRequest(url: string): Request {
	return new Request(url, {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({ kind: 'user', body: 'hello' }),
	});
}

describe('AgentDefinition.route()', () => {
	it('throws a directive hint when the definition has no identity binding and no registration', () => {
		const agent = defineAgent(() => ({ model: 'anthropic/claude-haiku-4-5' }));
		expect(() => agent.route()).toThrow("Add the 'use agent' directive");
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
				eventStreamStore: createTestEventStreamStore(),
			}),
		);

		const app = new Hono();
		app.route('/agents/triage', agent.route());
		app.route('/other/mount', agent.route());

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
				eventStreamStore: createTestEventStreamStore(),
			}),
		);
		const app = new Hono();
		app.route('/api/agents/triage', agent.route());

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

	it('serves a definition registered by the bootstrap without a module binding', async () => {
		const agent = defineAgent(() => ({ model: 'anthropic/claude-haiku-4-5' }));
		registerFlueAgents([{ definition: agent, identity: 'support' }]);
		const createAgentAdmission = vi.fn((_agentName: string, _id: string) => async () => ({
			submissionId: 'submission-1',
			offset: '-1',
		}));
		configureFlueRuntime(
			nodeRuntime({ createAgentAdmission, eventStreamStore: createTestEventStreamStore() }),
		);
		const app = new Hono();
		app.route('/agents/support', agent.route());

		const response = await app.fetch(promptRequest('http://localhost/agents/support/cust-9'));

		expect(response.status).toBe(202);
		expect(createAgentAdmission).toHaveBeenCalledWith('support', 'cust-9');
	});

	it('rejects the agent-prompt wait query with the canonical invalid_request envelope', async () => {
		const agent = boundAgent();
		configureFlueRuntime(
			nodeRuntime({
				createAgentAdmission: () => async () => ({ submissionId: 'submission-1', offset: '-1' }),
				eventStreamStore: createTestEventStreamStore(),
			}),
		);
		const app = new Hono();
		app.route('/agents/triage', agent.route());

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
		app.route('/agents/triage', agent.route());

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
		app.route('/agents/triage', agent.route());

		const response = await app.fetch(new Request('http://localhost/agents/triage/cust-1'));

		expect(response.status).toBe(404);
		const body = (await response.json()) as { error: { type: string } };
		expect(body.error.type).toBe('stream_not_found');
	});

	it('rejects unsupported methods with the canonical 405 envelope', async () => {
		const agent = boundAgent();
		configureFlueRuntime(nodeRuntime());
		const app = new Hono();
		app.route('/agents/triage', agent.route());

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
		app.route('/agents/triage', agent.route());

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
		app.route('/agents/triage', agent.route());

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

	it('applies the module route middleware to prompt, stream, and abort routes', async () => {
		const seen: string[] = [];
		const agent = boundAgent('triage', {
			route: async (c, next) => {
				seen.push(`${c.req.method} ${new URL(c.req.url).pathname}`);
				await next();
				c.header('x-authored-middleware', 'ran');
			},
		});
		configureFlueRuntime(
			nodeRuntime({
				createAgentAdmission: () => async () => ({ submissionId: 'submission-1', offset: '-1' }),
				abortAgentInstance: async () => false,
				eventStreamStore: createTestEventStreamStore(),
			}),
		);
		const app = new Hono();
		app.route('/agents/triage', agent.route());

		const prompt = await app.fetch(promptRequest('http://localhost/agents/triage/cust-1'));
		expect(prompt.status).toBe(202);
		expect(prompt.headers.get('x-authored-middleware')).toBe('ran');

		await app.fetch(new Request('http://localhost/agents/triage/cust-1'));
		await app.fetch(
			new Request('http://localhost/agents/triage/cust-1/abort', { method: 'POST' }),
		);

		expect(seen).toEqual([
			'POST /agents/triage/cust-1',
			'GET /agents/triage/cust-1',
			'POST /agents/triage/cust-1/abort',
		]);
	});

	it('lets route middleware short-circuit without reaching the handler', async () => {
		const createAgentAdmission = vi.fn();
		const agent = boundAgent('triage', {
			route: async (c) => c.json({ blocked: true }, 401),
		});
		configureFlueRuntime(nodeRuntime({ createAgentAdmission }));
		const app = new Hono();
		app.route('/agents/triage', agent.route());

		const response = await app.fetch(promptRequest('http://localhost/agents/triage/cust-1'));

		expect(response.status).toBe(401);
		expect(await response.json()).toEqual({ blocked: true });
		expect(createAgentAdmission).not.toHaveBeenCalled();
	});

	it('resolves metadata at request time, so a router built before a rebind sees the update', async () => {
		const agent = boundAgent('triage');
		configureFlueRuntime(
			nodeRuntime({
				createAgentAdmission: () => async () => ({ submissionId: 'submission-1', offset: '-1' }),
				eventStreamStore: createTestEventStreamStore(),
			}),
		);
		const app = new Hono();
		app.route('/agents/triage', agent.route());

		// Dev-reload style re-evaluation binds middleware after mounting.
		__flueBindAgentModule(agent, {
			identity: 'triage',
			route: async (c) => c.json({ blocked: true }, 401),
		});

		const response = await app.fetch(promptRequest('http://localhost/agents/triage/cust-1'));
		expect(response.status).toBe(401);
	});

	describe('attachments route', () => {
		it('renders the opt-out 404 when the module has no attachments export', async () => {
			const agent = boundAgent();
			configureFlueRuntime(nodeRuntime({ devMode: true }));
			const app = new Hono();
			app.route('/agents/triage', agent.route());

			const response = await app.fetch(
				new Request('http://localhost/agents/triage/inst-1/attachments/att-1'),
			);

			expect(response.status).toBe(404);
			const body = (await response.json()) as { error: { type: string; dev?: string } };
			expect(body.error.type).toBe('route_not_found');
			expect(body.error.dev).toContain('attachments');
		});

		it('runs the exposed attachments middleware before serving bytes', async () => {
			const agent = boundAgent('triage', {
				attachments: async (c) => c.text('forbidden', 403),
			});
			configureFlueRuntime(nodeRuntime());
			const app = new Hono();
			app.route('/agents/triage', agent.route());

			const response = await app.fetch(
				new Request('http://localhost/agents/triage/inst-1/attachments/att-1'),
			);

			expect(response.status).toBe(403);
			expect(await response.text()).toBe('forbidden');
		});

		it('reaches the byte handler when the attachments middleware calls next', async () => {
			const agent = boundAgent('triage', {
				attachments: async (_c, next) => {
					await next();
				},
			});
			configureFlueRuntime(nodeRuntime());
			const app = new Hono();
			app.route('/agents/triage', agent.route());

			// No stream exists yet, so the handler reports a missing stream —
			// distinct from the not-exposed 404 above.
			const response = await app.fetch(
				new Request('http://localhost/agents/triage/inst-1/attachments/att-1'),
			);

			expect(response.status).toBe(404);
			const body = (await response.json()) as { error: { type: string } };
			expect(body.error.type).toBe('stream_not_found');
		});

		it('rejects non-GET methods on an exposed attachments route', async () => {
			const agent = boundAgent('triage', {
				attachments: async (_c, next) => {
					await next();
				},
			});
			configureFlueRuntime(nodeRuntime());
			const app = new Hono();
			app.route('/agents/triage', agent.route());

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
			const agent = boundAgent('triage', {
				attachments: async (_c, next) => {
					await next();
				},
			});
			const routeAgentRequest = vi.fn(
				async (
					_request: Request,
					_env: unknown,
					_target: { agentName: string; instanceId: string },
				) => new Response('forwarded'),
			);
			configureFlueRuntime(cloudflareRuntime({ routeAgentRequest }));
			const app = new Hono();
			app.route('/agents/triage', agent.route());

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

		it('renders route_not_found when no DO matches the forwarded request', async () => {
			const agent = boundAgent();
			configureFlueRuntime(cloudflareRuntime({ routeAgentRequest: async () => null }));
			const app = new Hono();
			app.route('/agents/triage', agent.route());

			const response = await app.fetch(promptRequest('http://localhost/agents/triage/cust-1'));

			expect(response.status).toBe(404);
			const body = (await response.json()) as { error: { type: string } };
			expect(body.error.type).toBe('route_not_found');
		});
	});
});
