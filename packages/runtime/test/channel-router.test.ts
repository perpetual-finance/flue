import { Hono } from 'hono';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createChannelRouter } from '../src/runtime/channel-routes.ts';
import { configureFlueRuntime, resetFlueRuntimeForTests } from '../src/runtime/flue-app.ts';
import { nodeRuntime } from './helpers/runtime-config.ts';

afterEach(() => {
	resetFlueRuntimeForTests();
});

describe('createChannelRouter()', () => {
	it('serves a channel route relative to the mount point', async () => {
		const app = new Hono();
		app.route(
			'/channels/slack',
			createChannelRouter([
				{
					method: 'POST',
					path: '/events',
					handler: async (c) => c.json({ path: c.req.path, team: c.req.query('team') }),
				},
			]),
		);

		const response = await app.fetch(
			new Request('http://localhost/channels/slack/events?team=T123', { method: 'POST' }),
		);

		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({ path: '/channels/slack/events', team: 'T123' });
	});

	it('serves multi-segment route paths', async () => {
		const app = new Hono();
		app.route(
			'/channels/custom',
			createChannelRouter([
				{
					method: 'POST',
					path: '/webhooks/retries',
					handler: async (c) => c.text(c.req.param('suffix') ?? ''),
				},
			]),
		);

		const response = await app.fetch(
			new Request('http://localhost/channels/custom/webhooks/retries', { method: 'POST' }),
		);

		expect(response.status).toBe(200);
		expect(await response.text()).toBe('webhooks/retries');
	});

	it('preserves the request method for explicit HEAD routes', async () => {
		const handler = vi.fn(async (c: { req: { method: string } }) => {
			expect(c.req.method).toBe('HEAD');
			return new Response(null, { status: 204, headers: { 'x-endpoint-validation': 'accepted' } });
		});
		const app = new Hono();
		app.route(
			'/channels/intercom',
			createChannelRouter([{ method: 'HEAD', path: '/webhook', handler }]),
		);

		const response = await app.fetch(
			new Request('http://localhost/channels/intercom/webhook', { method: 'HEAD' }),
		);

		expect(response.status).toBe(204);
		expect(response.headers.get('x-endpoint-validation')).toBe('accepted');
		expect(handler).toHaveBeenCalledOnce();
	});

	it('renders method_not_allowed with the Allow header for a known path with the wrong method', async () => {
		const app = new Hono();
		app.route(
			'/channels/slack',
			createChannelRouter([
				{ method: 'POST', path: '/events', handler: async (c) => c.body(null, 200) },
				{ method: 'PUT', path: '/events', handler: async (c) => c.body(null, 202) },
			]),
		);

		const response = await app.fetch(new Request('http://localhost/channels/slack/events'));

		expect(response.status).toBe(405);
		expect(response.headers.get('allow')).toBe('POST, PUT');
		const body = (await response.json()) as { error: { type: string } };
		expect(body.error.type).toBe('method_not_allowed');
	});

	it('renders route_not_found for the mount root and unknown suffixes', async () => {
		const app = new Hono();
		app.route(
			'/channels/slack',
			createChannelRouter([
				{ method: 'POST', path: '/events', handler: async (c) => c.body(null, 200) },
			]),
		);

		const root = await app.fetch(
			new Request('http://localhost/channels/slack', { method: 'POST' }),
		);
		const unknown = await app.fetch(
			new Request('http://localhost/channels/slack/unknown', { method: 'POST' }),
		);

		expect(root.status).toBe(404);
		expect(((await root.json()) as { error: { type: string } }).error.type).toBe(
			'route_not_found',
		);
		expect(unknown.status).toBe(404);
		expect(((await unknown.json()) as { error: { type: string } }).error.type).toBe(
			'route_not_found',
		);
	});

	it('normalizes a channel response from another JavaScript realm', async () => {
		const nativeResponse = new Response('accepted', { status: 202 });
		const foreignResponse = new Proxy(nativeResponse, {
			get(target, property) {
				const value = Reflect.get(target, property, target);
				return typeof value === 'function' ? value.bind(target) : value;
			},
			getPrototypeOf() {
				return null;
			},
		});
		expect(foreignResponse).not.toBeInstanceOf(Response);

		const app = new Hono();
		app.route(
			'/channels/slack',
			createChannelRouter([
				{ method: 'POST', path: '/events', handler: async () => foreignResponse },
			]),
		);

		const response = await app.fetch(
			new Request('http://localhost/channels/slack/events', { method: 'POST' }),
		);

		expect(response.status).toBe(202);
		expect(await response.text()).toBe('accepted');
	});

	it('rejects a tagged non-Response value with an internal_error envelope', async () => {
		const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
		const app = new Hono();
		app.route(
			'/channels/slack',
			createChannelRouter([
				{
					method: 'POST',
					path: '/events',
					handler: async () => ({ [Symbol.toStringTag]: 'Response' }) as unknown as Response,
				},
			]),
		);

		try {
			const response = await app.fetch(
				new Request('http://localhost/channels/slack/events', { method: 'POST' }),
			);

			expect(response.status).toBe(500);
			expect(await response.json()).toMatchObject({ error: { type: 'internal_error' } });
		} finally {
			consoleError.mockRestore();
		}
	});

	it('holds a runtime activity lease until a streamed response body settles', async () => {
		let releases = 0;
		configureFlueRuntime(
			nodeRuntime({
				activityGate: {
					enter: () => ({
						release: () => {
							releases += 1;
						},
					}),
					pause: () => {},
					waitForIdle: async () => {},
				},
			}),
		);
		const app = new Hono();
		app.route(
			'/channels/slack',
			createChannelRouter([
				{ method: 'POST', path: '/events', handler: async () => new Response('streamed') },
			]),
		);

		const response = await app.fetch(
			new Request('http://localhost/channels/slack/events', { method: 'POST' }),
		);

		expect(response.status).toBe(200);
		expect(releases).toBe(0);
		expect(await response.text()).toBe('streamed');
		expect(releases).toBe(1);
	});

	describe('route validation', () => {
		it('requires at least one route', () => {
			expect(() => createChannelRouter([])).toThrow('at least one route');
		});

		it('rejects lowercase methods', () => {
			expect(() =>
				createChannelRouter([
					{ method: 'post', path: '/events', handler: async () => new Response() },
				]),
			).toThrow('uppercase ASCII');
		});

		it.each(['events', '/', '//events', '/events?x=1', '/events#frag'])(
			'rejects the invalid path %j',
			(path) => {
				expect(() =>
					createChannelRouter([{ method: 'POST', path, handler: async () => new Response() }]),
				).toThrow('non-empty absolute suffix');
			},
		);

		it('rejects dot segments that would escape the mount', () => {
			expect(() =>
				createChannelRouter([
					{ method: 'POST', path: '/../events', handler: async () => new Response() },
				]),
			).toThrow('must remain beneath its channel mount');
		});

		it('rejects non-callable handlers', () => {
			expect(() =>
				createChannelRouter([
					{ method: 'POST', path: '/events', handler: 'nope' as unknown as never },
				]),
			).toThrow('handler must be callable');
		});

		it('rejects duplicate method/path pairs', () => {
			expect(() =>
				createChannelRouter([
					{ method: 'POST', path: '/events', handler: async () => new Response() },
					{ method: 'POST', path: '/events', handler: async () => new Response() },
				]),
			).toThrow('duplicate route "POST /events"');
		});
	});
});
