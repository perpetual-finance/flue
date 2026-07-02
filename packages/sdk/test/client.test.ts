import { describe, expect, it } from 'vitest';
import {
	type ConversationStreamChunk,
	createFlueClient,
	FlueApiError,
} from '../src/index.ts';

describe('createFlueClient', () => {
	describe('default global fetch', () => {
		it('calls the global fetch with the correct receiver in a browser-like global', async () => {
			// Regression for "Illegal invocation" in browsers: when no custom fetch
			// is supplied, the SDK must invoke the global `fetch` with `globalThis`
			// as its receiver, not the HttpClient instance.
			const original = globalThis.fetch;
			let calledWithCorrectReceiver = false;
			globalThis.fetch = function (this: unknown) {
				if (this !== globalThis) {
					throw new TypeError("Failed to execute 'fetch': Illegal invocation");
				}
				calledWithCorrectReceiver = true;
				return Promise.resolve(
					Response.json({ streamUrl: 'https://flue.test/stream', offset: '-1', submissionId: 's1' }),
				);
			} as typeof fetch;
			try {
				const conversation = createFlueClient({ url: 'https://flue.test/agents/hello/inst-1' });
				await expect(
					conversation.send({ message: { kind: 'user', body: 'hi' } }),
				).resolves.toEqual({ streamUrl: 'https://flue.test/stream', offset: '-1', submissionId: 's1' });
				expect(calledWithCorrectReceiver).toBe(true);
			} finally {
				globalThis.fetch = original;
			}
		});
	});

	describe('send()', () => {
		it('POSTs the DeliveredMessage to exactly the conversation URL', async () => {
			const seen: Request[] = [];
			const conversation = createFlueClient({
				url: 'https://flue.test/agents/hello/inst-1',
				fetch: async (input, init) => {
					seen.push(new Request(input, init));
					return Response.json({ streamUrl: 'https://flue.test/stream', offset: '-1' });
				},
			});
			await conversation.send({
				message: {
					kind: 'user',
					body: 'Hello',
					attachments: [{ type: 'image', data: 'YWJj', mimeType: 'image/png' }],
				},
			});
			const [request] = seen;
			if (!request) throw new Error('Expected a send request.');
			expect(request.method).toBe('POST');
			expect(new URL(request.url).pathname).toBe('/agents/hello/inst-1');
			expect(await request.json()).toEqual({
				kind: 'user',
				body: 'Hello',
				attachments: [{ type: 'image', data: 'YWJj', mimeType: 'image/png' }],
			});
		});

		it('normalizes a trailing slash off the conversation URL', async () => {
			const urls: string[] = [];
			const conversation = createFlueClient({
				url: 'https://flue.test/agents/hello/inst-1/',
				fetch: async (input, init) => {
					urls.push(new Request(input, init).url);
					return Response.json({ streamUrl: 'https://flue.test/stream', offset: '-1' });
				},
			});
			expect(conversation.url).toBe('https://flue.test/agents/hello/inst-1');
			await conversation.send({ message: { kind: 'user', body: 'Hello' } });
			expect(new URL(urls[0] ?? '').pathname).toBe('/agents/hello/inst-1');
		});
	});

	describe('abort()', () => {
		it('POSTs to the conversation abort route and returns the abort result', async () => {
			const seen: Request[] = [];
			const conversation = createFlueClient({
				url: 'https://flue.test/agents/hello/inst-1',
				fetch: async (input, init) => {
					seen.push(new Request(input, init));
					return Response.json({ aborted: true });
				},
			});

			await expect(conversation.abort()).resolves.toEqual({ aborted: true });
			const [request] = seen;
			if (!request) throw new Error('Expected an abort request.');
			expect(request.method).toBe('POST');
			expect(new URL(request.url).pathname).toBe('/agents/hello/inst-1/abort');
		});
	});

	describe('attachmentUrl()', () => {
		it('resolves attachment URLs beneath the conversation URL', () => {
			const conversation = createFlueClient({ url: 'https://flue.test/agents/hello/inst-1' });
			expect(conversation.attachmentUrl('att 1')).toBe(
				'https://flue.test/agents/hello/inst-1/attachments/att%201',
			);
		});
	});

	describe('history() attachment urls', () => {
		it('resolves a url on durably-recorded file parts and leaves preview parts untouched', async () => {
			const conversation = createFlueClient({
				url: 'https://flue.test/agents/agent/inst-1',
				fetch: async () =>
					Response.json({
						v: 1,
						conversationId: 'c1',
						offset: '0000000000000000_0000000000000001',
						messages: [
							{
								id: 'u1',
								role: 'user',
								parts: [
									{ type: 'file', mediaType: 'image/png', id: 'att-1', size: 3 },
									{ type: 'file', mediaType: 'image/png', url: 'data:image/png;base64,AAAA' },
								],
							},
						],
						settlements: [],
					}),
			});

			const snapshot = await conversation.history();
			const parts = snapshot.messages[0]?.parts as Array<{ url?: string }>;
			expect(parts[0]?.url).toBe('https://flue.test/agents/agent/inst-1/attachments/att-1');
			// A part that already carries a url (e.g. an optimistic data URL) is left as-is.
			expect(parts[1]?.url).toBe('data:image/png;base64,AAAA');
		});
	});

	describe('observe()', () => {
		it('materializes history before following updates from the snapshot offset', async () => {
			const seen: string[] = [];
			let resolveFollowed!: () => void;
			const followed = new Promise<void>((resolve) => {
				resolveFollowed = resolve;
			});
			const conversation = createFlueClient({
				url: 'https://flue.test/agents/agent/id',
				fetch: async (input) => {
					const url = new URL(typeof input === 'string' ? input : new Request(input).url);
					seen.push(`${url.searchParams.get('view')}:${url.searchParams.get('offset') ?? ''}`);
					if (url.searchParams.get('view') === 'history') {
						return Response.json({
							v: 1,
							conversationId: 'conversation-1',
							offset: '0000000000000000_0000000000000001',
							messages: [{ id: 'entry-user', role: 'user', parts: [{ type: 'text', text: 'hello', state: 'done' }] }],
							settlements: [],
						});
					}
					resolveFollowed();
					return dsJsonResponse([], {
						nextOffset: '0000000000000000_0000000000000001',
						upToDate: true,
						closed: true,
					});
				},
			});
			const observation = conversation.observe();
			observation.subscribe(() => {});
			await followed;

			expect(observation.getSnapshot()).toMatchObject({
				offset: '0000000000000000_0000000000000001',
				conversation: { conversationId: 'conversation-1', messages: [{ id: 'entry-user' }] },
			});
			expect(seen).toEqual(['history:', 'updates:0000000000000000_0000000000000001']);
			observation.close();
		});

		it('reports an absent conversation and rehydrates after refresh', async () => {
			let historyCalls = 0;
			const conversation = createFlueClient({
				url: 'https://flue.test/agents/agent/id',
				fetch: async (input) => {
					const url = new URL(typeof input === 'string' ? input : new Request(input).url);
					if (url.searchParams.get('view') === 'history') {
						historyCalls++;
						if (historyCalls === 1) return Response.json({ error: { message: 'missing' } }, { status: 404 });
						return Response.json({
							v: 1,
							conversationId: 'conversation-1',
							offset: '0000000000000000_0000000000000001',
							messages: [],
							settlements: [],
						});
					}
					return dsJsonResponse([], {
						nextOffset: '0000000000000000_0000000000000001',
						upToDate: true,
						closed: true,
					});
				},
			});
			const observation = conversation.observe();
			const absent = new Promise<void>((resolve) => {
				const unsubscribe = observation.subscribe(() => {
					if (observation.getSnapshot().phase === 'absent') {
						unsubscribe();
						resolve();
					}
				});
			});
			await absent;

			const rehydrated = new Promise<void>((resolve) => {
				const unsubscribe = observation.subscribe(() => {
					if (observation.getSnapshot().conversation) {
						unsubscribe();
						resolve();
					}
				});
			});
			observation.refresh();
			await rehydrated;

			expect(observation.getSnapshot().conversation).toMatchObject({
				conversationId: 'conversation-1',
			});
			observation.close();
		});

		it('applies fan-out chunks and dedupes a redelivered batch by position', async () => {
			// started + two same-batch deltas (distinct index) + a later delta.
			const original: ConversationStreamChunk[] = [
				{ type: 'message-started', conversationId: 'c1', messageId: 'a1', position: { batch: 1, index: 0 } },
				{ type: 'message-delta', conversationId: 'c1', messageId: 'a1', kind: 'text', delta: 'hel', position: { batch: 2, index: 0 } },
				{ type: 'message-delta', conversationId: 'c1', messageId: 'a1', kind: 'text', delta: 'lo', position: { batch: 2, index: 1 } },
			];
			let updatesCalls = 0;
			const conversation = createFlueClient({
				url: 'https://flue.test/agents/agent/id',
				fetch: async (input) => {
					const url = new URL(typeof input === 'string' ? input : new Request(input).url);
					if (url.searchParams.get('view') === 'history') {
						return Response.json({ v: 1, conversationId: 'c1', offset: '0', messages: [], settlements: [] });
					}
					updatesCalls++;
					if (updatesCalls === 1) {
						return dsJsonResponse(original, { upToDate: false, nextOffset: '2' });
					}
					// Redelivery of the whole batch (as an SSE reconnect would replay)
					// plus one genuinely new delta. The replayed chunks must be skipped.
					return dsJsonResponse(
						[
							...original,
							{ type: 'message-delta', conversationId: 'c1', messageId: 'a1', kind: 'text', delta: '!', position: { batch: 3, index: 0 } },
						] satisfies ConversationStreamChunk[],
						{ closed: true, nextOffset: '3' },
					);
				},
			});

			const observation = conversation.observe();
			const settled = new Promise<void>((resolve) => {
				observation.subscribe(() => {
					const text = assistantText(observation.getSnapshot().conversation);
					if (text.endsWith('!')) resolve();
				});
			});
			await settled;

			expect(assistantText(observation.getSnapshot().conversation)).toBe('hello!');
			observation.close();
		});
	});

	describe('history()', () => {
		it('reads one materialized snapshot via the history view of the conversation URL', async () => {
			let seen = '';
			const conversation = createFlueClient({
				url: 'https://flue.test/api/agents/agent/id',
				fetch: async (input) => {
					seen = typeof input === 'string' ? input : new Request(input).url;
					return Response.json({
						v: 1,
						conversationId: 'conversation-1',
						offset: 'offset-1',
						messages: [],
						settlements: [],
					});
				},
			});

			await conversation.history();

			const url = new URL(seen);
			expect(url.pathname).toBe('/api/agents/agent/id');
			expect(url.searchParams.get('view')).toBe('history');
			expect(url.searchParams.has('harness')).toBe(false);
			expect(url.searchParams.has('session')).toBe(false);
			expect(url.searchParams.has('tail')).toBe(false);
		});
	});

	describe('wait()', () => {
		it('follows an admission from its offset and resolves on its settlement chunk', async () => {
			const offsets: Array<string | null> = [];
			const seenEvents: string[] = [];
			const conversation = createFlueClient({
				url: 'https://flue.test/agents/hello/instance-1',
				fetch: async (input) => {
					const url = new URL(typeof input === 'string' ? input : new Request(input).url);
					offsets.push(url.searchParams.get('offset'));
					return dsJsonResponse(
						[
							{ type: 'message-delta', conversationId: 'c1', messageId: 'a1', kind: 'text', delta: 'hello', position: { batch: 1, index: 0 } },
							{ type: 'submission-settled', conversationId: 'c1', submissionId: 'other', outcome: 'completed', position: { batch: 2, index: 0 } },
							{ type: 'submission-settled', conversationId: 'c1', submissionId: 'submission-1', outcome: 'completed', position: { batch: 3, index: 0 } },
						] satisfies ConversationStreamChunk[],
						{ closed: true },
					);
				},
			});

			await expect(
				conversation.wait(
					{
						streamUrl: 'https://flue.test/agents/hello/instance-1',
						offset: 'admission-offset',
						submissionId: 'submission-1',
					},
					{ onEvent: (event) => seenEvents.push(event.type) },
				),
			).resolves.toBeUndefined();
			expect(offsets).toEqual(['admission-offset']);
			expect(seenEvents).toEqual(['message-delta', 'submission-settled', 'submission-settled']);
		});

		it('throws a structured SDK error when the submission fails', async () => {
			const conversation = createFlueClient({
				url: 'https://flue.test/agents/hello/instance-1',
				fetch: async () =>
					dsJsonResponse(
						[
							{
								type: 'submission-settled',
								conversationId: 'c1',
								submissionId: 'submission-1',
								outcome: 'failed',
								error: { name: 'Error', message: 'model unavailable' },
								position: { batch: 1, index: 0 },
							},
						] satisfies ConversationStreamChunk[],
						{ closed: true },
					),
			});

			const error = await conversation
				.wait({
					streamUrl: 'https://flue.test/agents/hello/instance-1',
					offset: 'admission-offset',
					submissionId: 'submission-1',
				})
				.catch((error: unknown) => error);

			expect(error).toMatchObject({
				name: 'FlueExecutionError',
				target: 'agent_submission',
				targetId: 'submission-1',
				failure: 'failed',
				error: { name: 'Error', message: 'model unavailable' },
			});
		});

		it('classifies an aborted settlement distinctly from a failure', async () => {
			const conversation = createFlueClient({
				url: 'https://flue.test/agents/hello/instance-1',
				fetch: async () =>
					dsJsonResponse(
						[
							{
								type: 'submission-settled',
								conversationId: 'c1',
								submissionId: 'submission-1',
								outcome: 'aborted',
								error: { name: 'SubmissionAbortedError', message: 'Submission was aborted.' },
								position: { batch: 1, index: 0 },
							},
						] satisfies ConversationStreamChunk[],
						{ closed: true },
					),
			});

			const error = await conversation
				.wait({
					streamUrl: 'https://flue.test/agents/hello/instance-1',
					offset: 'admission-offset',
					submissionId: 'submission-1',
				})
				.catch((error: unknown) => error);

			expect(error).toMatchObject({
				name: 'FlueExecutionError',
				target: 'agent_submission',
				targetId: 'submission-1',
				failure: 'aborted',
			});
			expect((error as Error).message).toContain('was aborted');
		});
	});

	describe('URL resolution', () => {
		it('resolves relative conversation URLs against the browser origin', async () => {
			const original = Object.getOwnPropertyDescriptor(globalThis, 'location');
			Object.defineProperty(globalThis, 'location', {
				configurable: true,
				value: { origin: 'https://app.test' },
			});
			try {
				let url = '';
				const conversation = createFlueClient({
					url: '/api/agents/hello/inst-1',
					fetch: async (input) => {
						url = typeof input === 'string' ? input : new Request(input).url;
						return Response.json({ aborted: false });
					},
				});
				await conversation.abort();
				expect(url).toBe('https://app.test/api/agents/hello/inst-1/abort');
			} finally {
				if (original) Object.defineProperty(globalThis, 'location', original);
				else Reflect.deleteProperty(globalThis, 'location');
			}
		});

		it('rejects relative conversation URLs outside a browser', () => {
			expect(() => createFlueClient({ url: '/api/agents/hello/inst-1' })).toThrow(
				'relative url requires a browser; pass an absolute URL',
			);
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
			const conversation = createFlueClient({
				url: 'https://flue.test/agents/hello/inst-1',
				fetch: async () => Response.json(body, { status: 404 }),
			});

			const error = await conversation
				.send({ message: { kind: 'user', body: 'Hello' } })
				.catch((error: unknown) => error);

			expect(error).toBeInstanceOf(FlueApiError);
			if (!(error instanceof FlueApiError)) throw error;
			expect(error.name).toBe('FlueApiError');
			expect(error.status).toBe(404);
			expect(error.body).toEqual(body);
			expect(error.message).toBe('Flue API error 404 [agent_not_found]: Agent not found.');
		});

		it('preserves parsed null HTTP API error bodies', async () => {
			const conversation = createFlueClient({
				url: 'https://flue.test/agents/hello/inst-1',
				fetch: async () => Response.json(null, { status: 500 }),
			});

			const error = await conversation.history().catch((error: unknown) => error);

			expect(error).toBeInstanceOf(FlueApiError);
			if (!(error instanceof FlueApiError)) throw error;
			expect(error.body).toBeNull();
		});
	});
});

// ─── Test helpers ───────────────────────────────────────────────────────────

function assistantText(conversation: { messages: Array<{ id: string; parts: unknown[] }> } | undefined): string {
	const message = conversation?.messages.find((entry) => entry.id === 'a1');
	if (!message) return '';
	return message.parts
		.filter((part): part is { type: string; text: string } =>
			typeof part === 'object' && part !== null && (part as { type?: unknown }).type === 'text',
		)
		.map((part) => part.text)
		.join('');
}

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
	return new Response(
		JSON.stringify(
			events.map((event) =>
				event && typeof event === 'object' && !('v' in event) ? { ...event, v: 3 } : event,
			),
		),
		{ status: 200, headers },
	);
}
