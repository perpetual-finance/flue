import { getEventListeners } from 'node:events';
import { describe, expect, it } from 'vitest';
import {
	type AgentPromptOptions,
	createFlueClient,
	FlueApiError,
} from '../src/index.ts';

describe('createFlueClient', () => {
	describe('agents.prompt()', () => {
		it('sends agent prompt requests as POST with JSON body', async () => {
			const seen: Request[] = [];
			const client = createFlueClient({
				baseUrl: 'https://flue.test',
				fetch: async (input, init) => {
					seen.push(new Request(input, init));
					return Response.json({ result: { ok: true } });
				},
			});

			const options: AgentPromptOptions = {
				message: 'Hello',
				images: [{ type: 'image', data: 'YWJj', mimeType: 'image/png' }],
			};

			await expect(client.agents.prompt('hello', 'inst-1', options)).resolves.toEqual({
				result: { ok: true },
			});
			expect(seen).toHaveLength(1);
			expect(new URL(seen[0]?.url ?? '').pathname).toBe('/agents/hello/inst-1');
			expect(seen[0]?.method).toBe('POST');
			expect(await seen[0]?.json()).toEqual({
				message: 'Hello',
				images: [{ type: 'image', data: 'YWJj', mimeType: 'image/png' }],
			});
		});
	});

	describe('agents.send()', () => {
		it('sends images in the accepted prompt body', async () => {
			const seen: Request[] = [];
			const client = createFlueClient({
				baseUrl: 'https://flue.test',
				fetch: async (input, init) => {
					seen.push(new Request(input, init));
					return Response.json({ streamUrl: 'https://flue.test/stream', offset: '-1' });
				},
			});
			await client.agents.send('hello', 'inst-1', {
				message: 'Hello',
				images: [{ type: 'image', data: 'YWJj', mimeType: 'image/png' }],
			});
			expect(await seen[0]?.json()).toEqual({
				message: 'Hello',
				images: [{ type: 'image', data: 'YWJj', mimeType: 'image/png' }],
			});
		});
	});

	describe('agents.stream()', () => {
		it('constructs the correct stream URL from agent name and id', async () => {
			const urls: string[] = [];
			const client = createFlueClient({
				baseUrl: 'https://flue.test/api/',
				fetch: async (input) => {
					urls.push(typeof input === 'string' ? input : new Request(input).url);
					return dsJsonResponse([{ type: 'idle' }]);
				},
			});

			const eventStream = client.agents.stream('my-agent', 'inst-1', {
				offset: '0000000000000000_0000000000000042',
				live: false,
			});
			const events = [];
			for await (const event of eventStream) {
				events.push(event);
			}
			expect(events).toEqual([{ type: 'idle' }]);
			expect(urls.length).toBeGreaterThanOrEqual(1);
			const parsed = new URL(urls[0]!);
			expect(parsed.pathname).toBe('/api/agents/my-agent/inst-1');
			expect(parsed.searchParams.get('offset')).toBe('0000000000000000_0000000000000042');
		});

		it('passes auth headers to the DS stream via fetch wrapper', async () => {
			const seenHeaders: Record<string, string>[] = [];
			const client = createFlueClient({
				baseUrl: 'https://flue.test',
				token: 'test-token-123',
				headers: { 'x-custom': 'value' },
				fetch: async (input, init) => {
					const h = init?.headers as Record<string, string> | undefined;
					if (h) seenHeaders.push({ ...h });
					return dsJsonResponse([]);
				},
			});

			const eventStream = client.agents.stream('agent', 'id', { live: false });
			// Consume the stream to trigger the fetch.
			for await (const _ of eventStream) {
				// empty
			}
			expect(seenHeaders.length).toBeGreaterThanOrEqual(1);
			expect(seenHeaders[0]).toMatchObject({
				authorization: 'Bearer test-token-123',
				'x-custom': 'value',
			});
		});

		it('cancel() before iteration does not start a connection', async () => {
			let fetchCount = 0;
			const client = createFlueClient({
				baseUrl: 'https://flue.test',
				fetch: async () => {
					fetchCount++;
					return dsJsonResponse([]);
				},
			});

			const eventStream = client.agents.stream('agent', 'id', { live: false });
			eventStream.cancel();
			const events = [];
			for await (const event of eventStream) {
				events.push(event);
			}

			expect(events).toEqual([]);
			expect(fetchCount).toBe(0);
		});

		it('stops cleanly when canceled during initial connection', async () => {
			const client = createFlueClient({
				baseUrl: 'https://flue.test',
				fetch: async (_input, init) =>
					await new Promise<Response>((_resolve, reject) => {
						init?.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
					}),
			});

			const eventStream = client.agents.stream('agent', 'id', { live: false });
			const next = eventStream[Symbol.asyncIterator]().next();
			await new Promise((resolve) => setTimeout(resolve, 0));
			eventStream.cancel();

			await expect(next).resolves.toEqual({ value: undefined, done: true });
		});

		it('removes the listener on an external signal when the initial connection fails', async () => {
			const client = createFlueClient({
				baseUrl: 'https://flue.test',
				fetch: async () => new Response('not found', { status: 404 }),
			});

			// A long-lived signal reused across retry attempts must not
			// accumulate one 'abort' listener per failed connection.
			const controller = new AbortController();
			const eventStream = client.agents.stream('agent', 'missing', { live: false, signal: controller.signal });
			const iterator = eventStream[Symbol.asyncIterator]();

			await expect(iterator.next()).rejects.toThrow();
			expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0);
		});

		it('tracks the latest stream offset after reading an event', async () => {
			const client = createFlueClient({
				baseUrl: 'https://flue.test',
				fetch: async () =>
					dsJsonResponse([{ type: 'agent_start' }], {
						nextOffset: '0000000000000000_0000000000000001',
						closed: true,
					}),
			});

			const eventStream = client.agents.stream('agent', 'id', { live: false });
			expect(eventStream.offset).toBe('-1');
			const iterator = eventStream[Symbol.asyncIterator]();
			await iterator.next();
			expect(eventStream.offset).toBe('0000000000000000_0000000000000001');
		});

		it('advances offset only when the last event of a batch has been delivered', async () => {
			const client = createFlueClient({
				baseUrl: 'https://flue.test',
				fetch: async (input) => {
					const url = new URL(typeof input === 'string' ? input : new Request(input).url);
					if (url.searchParams.get('offset') === '-1') {
						return dsJsonResponse([{ type: 'agent_start' }, { type: 'turn_start' }], {
							nextOffset: '0000000000000000_0000000000000002',
						});
					}
					return dsJsonResponse([{ type: 'idle' }], {
						closed: true,
						nextOffset: '0000000000000000_0000000000000003',
					});
				},
			});

			// Default live mode: the DS client prefetches the next batch while
			// the current one is still being delivered. The public offset must
			// track delivered batches, not fetched responses, or resuming from
			// a checkpoint skips events that were never delivered.
			const eventStream = client.agents.stream('agent', 'id');
			const iterator = eventStream[Symbol.asyncIterator]();

			await iterator.next(); // agent_start — mid-batch 1
			expect(eventStream.offset).toBe('-1');
			await iterator.next(); // turn_start — last event of batch 1
			expect(eventStream.offset).toBe('0000000000000000_0000000000000002');
			await iterator.next(); // idle — last event of batch 2
			expect(eventStream.offset).toBe('0000000000000000_0000000000000003');
			await expect(iterator.next()).resolves.toEqual({ value: undefined, done: true });
		});

		it('cancel() stops iteration and aborts the underlying connection', async () => {
			let fetchCount = 0;
			let lastSignal: AbortSignal | undefined;
			const client = createFlueClient({
				baseUrl: 'https://flue.test',
				fetch: async (_input, init) => {
					fetchCount++;
					lastSignal = init?.signal as AbortSignal | undefined;
					return dsJsonResponse([{ type: 'agent_start' }]);
				},
			});

			const eventStream = client.agents.stream('agent', 'id', { live: false });
			const events = [];
			for await (const event of eventStream) {
				events.push(event);
				// Cancel after receiving the first event.
				eventStream.cancel();
			}
			expect(events).toHaveLength(1);
			expect(events[0]).toMatchObject({ type: 'agent_start' });
			expect(fetchCount).toBe(1);
			expect(lastSignal?.aborted).toBe(true);
		});
	});

	describe('runs.stream()', () => {
		it('constructs the correct stream URL from run ID', async () => {
			const urls: string[] = [];
			const client = createFlueClient({
				baseUrl: 'https://flue.test',
				fetch: async (input) => {
					urls.push(typeof input === 'string' ? input : new Request(input).url);
					return dsJsonResponse([{ type: 'run_end', runId: 'run-1', isError: false, durationMs: 100 }], { closed: true });
				},
			});

			const events = [];
			for await (const event of client.runs.stream('run-1', { live: false })) {
				events.push(event);
			}
			expect(events).toHaveLength(1);
			expect(events[0]).toMatchObject({ type: 'run_end' });
			const parsed = new URL(urls[0]!);
			expect(parsed.pathname).toBe('/runs/run-1');
		});

		it('yields the full history with live:false when the server splits catch-up into multiple batches', async () => {
			const client = createFlueClient({
				baseUrl: 'https://flue.test',
				fetch: async (input) => {
					const url = new URL(typeof input === 'string' ? input : new Request(input).url);
					if (url.searchParams.get('offset') === '-1') {
						// Server caps the batch and omits Stream-Up-To-Date.
						return dsJsonResponse(
							[
								{ type: 'run_start', runId: 'run-1' },
								{ type: 'turn_start', runId: 'run-1' },
							],
							{ upToDate: false, nextOffset: '0000000000000000_0000000000000002' },
						);
					}
					return dsJsonResponse([{ type: 'run_end', runId: 'run-1', isError: false, durationMs: 50 }], {
						closed: true,
						nextOffset: '0000000000000000_0000000000000003',
					});
				},
			});

			const events = [];
			for await (const event of client.runs.stream('run-1', { live: false })) {
				events.push(event);
			}
			expect(events).toHaveLength(3);
			expect(events[2]).toMatchObject({ type: 'run_end' });
		});
	});

	describe('runs.events()', () => {
		it('returns all run events as an array', async () => {
			const client = createFlueClient({
				baseUrl: 'https://flue.test',
				fetch: async () =>
					dsJsonResponse(
						[
							{ type: 'run_start', runId: 'r1' },
							{ type: 'run_end', runId: 'r1', isError: false, durationMs: 50 },
						],
						{ closed: true },
					),
			});

			const events = await client.runs.events('r1');
			expect(events).toHaveLength(2);
			expect(events[0]).toMatchObject({ type: 'run_start' });
			expect(events[1]).toMatchObject({ type: 'run_end' });
		});

		it('returns the full history when the server splits catch-up into multiple batches', async () => {
			const offsets: Array<string | null> = [];
			const client = createFlueClient({
				baseUrl: 'https://flue.test',
				fetch: async (input) => {
					const url = new URL(typeof input === 'string' ? input : new Request(input).url);
					const offset = url.searchParams.get('offset');
					offsets.push(offset);
					if (offset === '-1') {
						// Server caps the batch and omits Stream-Up-To-Date.
						return dsJsonResponse(
							[
								{ type: 'run_start', runId: 'r1' },
								{ type: 'turn_start', runId: 'r1' },
							],
							{ upToDate: false, nextOffset: '0000000000000000_0000000000000002' },
						);
					}
					return dsJsonResponse([{ type: 'run_end', runId: 'r1', isError: false, durationMs: 50 }], {
						closed: true,
						nextOffset: '0000000000000000_0000000000000003',
					});
				},
			});

			const events = await client.runs.events('r1');
			expect(events).toHaveLength(3);
			expect(events[2]).toMatchObject({ type: 'run_end' });
			expect(offsets).toEqual(['-1', '0000000000000000_0000000000000002']);
		});
	});

	describe('workflows.invoke()', () => {
		it('POSTs to workflow route and returns runId + streamUrl', async () => {
			const seen: Request[] = [];
			const client = createFlueClient({
				baseUrl: 'https://flue.test',
				fetch: async (input, init) => {
					seen.push(new Request(input, init));
					return Response.json({ status: 'accepted', runId: 'wf_abc123' }, { status: 202 });
				},
			});

			const result = await client.workflows.invoke('my-workflow', {
				payload: { key: 'value' },
			});
			expect(result.runId).toBe('wf_abc123');
			expect(result.streamUrl).toBe('https://flue.test/runs/wf_abc123');
			expect(seen).toHaveLength(1);
			expect(new URL(seen[0]!.url).pathname).toBe('/workflows/my-workflow');
			expect(seen[0]!.method).toBe('POST');
			expect(await seen[0]!.json()).toEqual({ key: 'value' });
		});

		it('works without a payload', async () => {
			const client = createFlueClient({
				baseUrl: 'https://flue.test',
				fetch: async () =>
					Response.json({ status: 'accepted', runId: 'wf_xyz' }, { status: 202 }),
			});

			const result = await client.workflows.invoke('simple-workflow');
			expect(result.runId).toBe('wf_xyz');
			expect(result.streamUrl).toBe('https://flue.test/runs/wf_xyz');
		});
	});

	describe('URL resolution', () => {
		it('resolves public HTTP routes beneath the base URL pathname', async () => {
			const requests: Request[] = [];
			const client = createFlueClient({
				baseUrl: 'https://flue.test/api/',
				fetch: async (input, init) => {
					const request = new Request(input, init);
					requests.push(request);
					if (request.method === 'POST') return Response.json({ result: { ok: true } });
					return Response.json({ runId: 'run-1' });
				},
			});

			await client.agents.prompt('hello', 'inst-1', { message: 'Hello' });
			await client.runs.get('run-1');

			expect(requests.map(({ url }) => new URL(url).pathname)).toEqual([
				'/api/agents/hello/inst-1',
				'/api/runs/run-1',
			]);
		});
	});

	describe('runs.get()', () => {
		it('requests the public ?meta view of the run route', async () => {
			let url = '';
			const client = createFlueClient({
				baseUrl: 'https://flue.test/api/',
				fetch: async (input, init) => {
					url = new Request(input, init).url;
					return Response.json({
						runId: 'run-1',
						workflowName: 'daily-report',
						status: 'completed',
						startedAt: '2026-06-01T10:00:00.000Z',
					});
				},
			});

			await expect(client.runs.get('run-1')).resolves.toMatchObject({
				runId: 'run-1',
				workflowName: 'daily-report',
			});
			const parsed = new URL(url);
			expect(parsed.pathname).toBe('/api/runs/run-1');
			expect(parsed.searchParams.has('meta')).toBe(true);
		});
	});

	describe('error handling', () => {
		it('exposes structured HTTP API errors', async () => {
			const body = {
				error: {
					type: 'agent_not_found',
					message: 'Agent not found.',
					details: 'No exposed agent named hello exists.',
				},
			};
			const client = createFlueClient({
				baseUrl: 'https://flue.test',
				fetch: async () => Response.json(body, { status: 404 }),
			});

			const error = await client.agents
				.prompt('hello', 'inst-1', { message: 'Hello' })
				.catch((error: unknown) => error);

			expect(error).toBeInstanceOf(FlueApiError);
			if (!(error instanceof FlueApiError)) throw error;
			expect(error.name).toBe('FlueApiError');
			expect(error.status).toBe(404);
			expect(error.body).toEqual(body);
			expect(error.message).toBe('Flue API error 404 [agent_not_found]: Agent not found.');
		});

		it('preserves parsed null HTTP API error bodies', async () => {
			const client = createFlueClient({
				baseUrl: 'https://flue.test',
				fetch: async () => Response.json(null, { status: 500 }),
			});

			const error = await client.runs.get('run-1').catch((error: unknown) => error);

			expect(error).toBeInstanceOf(FlueApiError);
			if (!(error instanceof FlueApiError)) throw error;
			expect(error.body).toBeNull();
		});
	});

});

// ─── Test helpers ───────────────────────────────────────────────────────────

/**
 * Build a DS-compliant JSON catch-up response. Used by stream tests to
 * simulate the server without a real DS server.
 */
function dsJsonResponse(
	events: unknown[],
	opts: { closed?: boolean; upToDate?: boolean; nextOffset?: string } = {},
): Response {
	const nextOffset = opts.nextOffset ?? String(events.length).padStart(16, '0');
	const headers: Record<string, string> = {
		'content-type': 'application/json',
		'stream-next-offset': nextOffset,
	};
	if (opts.upToDate !== false) {
		headers['stream-up-to-date'] = 'true';
	}
	if (opts.closed) {
		headers['stream-closed'] = 'true';
	}
	return new Response(JSON.stringify(events), { status: 200, headers });
}
