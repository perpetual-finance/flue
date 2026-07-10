import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {
	type FauxProviderRegistration,
	fauxAssistantMessage,
	fauxToolCall,
	registerFauxProvider,
} from '@earendil-works/pi-ai/compat';
import * as v from 'valibot';
import { afterEach, describe, expect, it } from 'vitest';
import { defineAgent } from '../src/agent-definition.ts';
import { projectConversationUi } from '../src/conversation-projections.ts';
import type { ConversationRecord } from '../src/conversation-records.ts';
import {
	createReducedInstanceState,
	reduceConversationRecords,
} from '../src/conversation-reducer.ts';
import { renderWithFrame } from '../src/hooks/frame.ts';
import {
	assertRenderStructureInvariance,
	renderAgentFunctionWithStructure,
} from '../src/hooks/render.ts';
import { useDataWriter } from '../src/hooks/use-data-writer.ts';
import { useModel } from '../src/hooks/use-model.ts';
import { useResponseFinish } from '../src/hooks/use-response-finish.ts';
import { useResponseStart } from '../src/hooks/use-response-start.ts';
import { useTool } from '../src/hooks/use-tool.ts';
import { createFlueContext, type DispatchInput } from '../src/internal.ts';
import { createAgentOutputChannel, runResponseMetadataHooks } from '../src/message-output.ts';
import { createNodeAgentCoordinator } from '../src/node/agent-coordinator.ts';
import { sqlite } from '../src/node/agent-execution-store.ts';
import type { CreateAgentContextFn } from '../src/runtime/handle-agent.ts';
import { createNoopSessionEnv } from './fixtures/session-env.ts';

const providers: FauxProviderRegistration[] = [];
const tempDirs: string[] = [];

afterEach(() => {
	for (const provider of providers.splice(0)) provider.unregister();
	for (const dir of tempDirs.splice(0)) {
		try {
			rmSync(dir, { recursive: true });
		} catch {}
	}
});

function createFauxProvider(): FauxProviderRegistration {
	const provider = registerFauxProvider({
		provider: `agent-output-hooks-test-${crypto.randomUUID()}`,
	});
	providers.push(provider);
	return provider;
}

function createTempDbPath(): string {
	const dir = mkdtempSync(join(tmpdir(), 'flue-agent-output-hooks-'));
	tempDirs.push(dir);
	return join(dir, 'agent.db');
}

function makeFauxCreateContext(provider: FauxProviderRegistration): CreateAgentContextFn {
	return ({ id, request, initialEventIndex, dispatchId }) =>
		createFlueContext({
			id,
			dispatchId,
			env: {},
			req: request,
			initialEventIndex,
			agentConfig: {
				subagents: {},
				resolveModel: () => provider.getModel(),
			},
			createDefaultEnv: async () => createNoopSessionEnv({ cwd: '/' }),
		});
}

function makeDispatchInput(overrides: Partial<DispatchInput> = {}): DispatchInput {
	return {
		dispatchId: `dispatch-${crypto.randomUUID()}`,
		agent: 'assistant',
		id: 'instance-1',
		message: { kind: 'signal', type: 'test.event', body: 'Hello' },
		acceptedAt: new Date().toISOString(),
		...overrides,
	};
}

async function connectSqlite(dbPath: string) {
	const adapter = sqlite(dbPath);
	await adapter.migrate?.();
	return adapter.connect();
}

function readDurableRecords(dbPath: string): ConversationRecord[] {
	const db = new DatabaseSync(dbPath);
	const rows = db
		.prepare('SELECT data FROM flue_conversation_stream_batches ORDER BY seq')
		.all() as Array<{ data: string }>;
	db.close();
	return rows.flatMap((row) => JSON.parse(row.data) as ConversationRecord[]);
}

const CONFIG = { model: 'faux/agent-output-hooks' };

describe('useDataWriter()', () => {
	it('rejects duplicate names in one render', () => {
		expect(() =>
			renderAgentFunctionWithStructure(() => {
				useModel(CONFIG.model);
				useDataWriter({ name: 'caseCard' });
				useDataWriter({ name: 'caseCard' });
				return 'Base.';
			}),
		).toThrow(/Duplicate useDataWriter name "caseCard"/);
	});

	it('is unavailable in subagent renders', () => {
		expect(() =>
			renderWithFrame(
				() => {
					useDataWriter({ name: 'caseCard' });
				},
				undefined,
				'subagent',
			),
		).toThrow(/not available in a subagent render/);
	});

	it('rejects writes made during render', () => {
		expect(() =>
			renderAgentFunctionWithStructure(() => {
				useModel(CONFIG.model);
				const writeCaseCardData = useDataWriter({ name: 'caseCard' });
				writeCaseCardData({ status: 'loading' });
				return 'Base.';
			}),
		).toThrow(/written during render/);
	});

	it('throws on write when no durable runtime backs the render', () => {
		let writeCaseCardData: ((data: unknown) => void) | undefined;
		renderAgentFunctionWithStructure(() => {
			useModel(CONFIG.model);
			writeCaseCardData = useDataWriter({ name: 'caseCard' });
			return 'Base.';
		});
		expect(() => writeCaseCardData?.({ status: 'loading' })).toThrow(/no durable runtime/);
	});

	it('validates writes against the schema and JSON-normalizes them', () => {
		const channel = createAgentOutputChannel();
		const written: Array<{ name: string; data: unknown }> = [];
		channel.connect((name, data) => written.push({ name, data }));
		let writeCaseCardData: ((data: unknown) => void) | undefined;
		renderAgentFunctionWithStructure(
			() => {
				useModel(CONFIG.model);
				// Widened on purpose: the test feeds schema-invalid values through.
				writeCaseCardData = useDataWriter({
					name: 'caseCard',
					schema: v.object({ status: v.picklist(['loading', 'loaded']) }),
				}) as (data: unknown) => void;
				return 'Base.';
			},
			{ snapshot: new Map(), store: undefined, output: channel },
		);

		expect(() => writeCaseCardData?.({ status: 'bogus' })).toThrow(/does not match its schema/);
		expect(() => writeCaseCardData?.(undefined)).toThrow(/does not match its schema/);
		writeCaseCardData?.({ status: 'loading' });
		expect(written).toEqual([{ name: 'caseCard', data: { status: 'loading' } }]);
	});

	it('joins the render structure, so conditional mounts violate invariance', () => {
		const render = (mount: boolean) =>
			renderAgentFunctionWithStructure(() => {
				useModel(CONFIG.model);
				if (mount) useDataWriter({ name: 'caseCard' });
				return 'Base.';
			}).structure;
		expect(() => assertRenderStructureInvariance(render(true), render(false))).toThrow(
			/message data removed caseCard/,
		);
	});
});

describe('useResponseStart() / useResponseFinish()', () => {
	it('rejects a non-function argument', () => {
		expect(() =>
			renderAgentFunctionWithStructure(() => {
				useModel(CONFIG.model);
				// @ts-expect-error the hook takes a callback
				useResponseStart({ startedAt: 1 });
				return 'Base.';
			}),
		).toThrow(/takes a callback as its only argument/);
		expect(() =>
			renderAgentFunctionWithStructure(() => {
				useModel(CONFIG.model);
				// @ts-expect-error the hook takes a callback
				useResponseFinish({ finishedAt: 1 });
				return 'Base.';
			}),
		).toThrow(/takes a callback as its only argument/);
	});

	it('is unavailable in subagent renders', () => {
		expect(() =>
			renderWithFrame(
				() => {
					useResponseStart(() => ({}));
				},
				undefined,
				'subagent',
			),
		).toThrow(/not available in a subagent render/);
		expect(() =>
			renderWithFrame(
				() => {
					useResponseFinish(() => ({}));
				},
				undefined,
				'subagent',
			),
		).toThrow(/not available in a subagent render/);
	});

	it("hands the render's declarations to the output channel in call order", () => {
		const channel = createAgentOutputChannel();
		renderAgentFunctionWithStructure(
			() => {
				useModel(CONFIG.model);
				useResponseStart(() => ({ a: 1 }));
				useResponseFinish(() => ({ b: 2 }));
				useResponseFinish(() => ({ c: 3 }));
				return 'Base.';
			},
			{ snapshot: new Map(), store: undefined, output: channel },
		);
		expect(channel.responseStarts).toHaveLength(1);
		expect(channel.responseFinishes).toHaveLength(2);
	});

	it('joins the render structure, so conditional mounts violate invariance', () => {
		const render = (mount: boolean) =>
			renderAgentFunctionWithStructure(() => {
				useModel(CONFIG.model);
				if (mount) useResponseStart(() => ({}));
				useResponseFinish(() => ({}));
				return 'Base.';
			}).structure;
		expect(() => assertRenderStructureInvariance(render(true), render(false))).toThrow(
			/useResponseStart count changed \(1 → 0\)/,
		);
	});
});

describe('runResponseMetadataHooks()', () => {
	const ctxOf = (metadata: Record<string, unknown>) => ({ metadata });

	it('threads accumulated metadata into each context and returns only contributions', () => {
		const seen: Record<string, unknown>[] = [];
		const result = runResponseMetadataHooks(
			'useResponseStart',
			[
				{
					run: (ctx: { metadata: Record<string, unknown> }) => {
						seen.push(ctx.metadata);
						return { a: 1 };
					},
				},
				{
					run: (ctx: { metadata: Record<string, unknown> }) => {
						seen.push(ctx.metadata);
						return { b: (ctx.metadata.a as number) + 1 };
					},
				},
			],
			ctxOf,
			{ seed: 'durable' },
		);
		// Each hook saw the initial metadata plus earlier contributions…
		expect(seen).toEqual([{ seed: 'durable' }, { seed: 'durable', a: 1 }]);
		// …but the return carries only what the hooks contributed.
		expect(result).toEqual({ a: 1, b: 2 });
	});

	it('returns undefined when no hook contributes', () => {
		expect(
			runResponseMetadataHooks('useResponseFinish', [{ run: () => undefined }], ctxOf, {}),
		).toBeUndefined();
	});

	it('rejects a promise return with the synchronous-observer error', () => {
		expect(() =>
			runResponseMetadataHooks(
				'useResponseStart',
				[{ run: () => Promise.resolve({}) as unknown as Record<string, unknown> }],
				ctxOf,
				{},
			),
		).toThrow(/useResponseStart callback \(hook #0 in declaration order\) returned a promise/);
	});

	it('rejects non-object returns', () => {
		expect(() =>
			runResponseMetadataHooks(
				'useResponseFinish',
				[{ run: () => 42 as unknown as Record<string, unknown> }],
				ctxOf,
				{},
			),
		).toThrow(/must return a plain object of metadata \(or nothing\) — got number/);
		expect(() =>
			runResponseMetadataHooks(
				'useResponseFinish',
				[{ run: () => [1] as unknown as Record<string, unknown> }],
				ctxOf,
				{},
			),
		).toThrow(/must return a plain object of metadata \(or nothing\) — got an array/);
	});

	it('wraps a throw with the hook name and declaration index', () => {
		expect(() =>
			runResponseMetadataHooks(
				'useResponseFinish',
				[
					{ run: () => ({}) },
					{
						run: () => {
							throw new Error('boom');
						},
					},
				],
				ctxOf,
				{},
			),
		).toThrow(/useResponseFinish callback \(hook #1 in declaration order\) threw: boom/);
	});
});

describe('output hooks end to end (node coordinator, faux provider)', () => {
	it('streams live data parts onto the response message and stamps boundary metadata', async () => {
		const dbPath = createTempDbPath();
		const { executionStore, conversationStreamStore, attachmentStore } =
			await connectSqlite(dbPath);
		const provider = createFauxProvider();

		provider.setResponses([
			fauxAssistantMessage(fauxToolCall('load_case', {}, { id: 'tool-load-1' }), {
				stopReason: 'toolUse',
			}),
			fauxAssistantMessage('Done.'),
		]);

		function assistant() {
			useModel(`${provider.getModel().provider}/${provider.getModel().id}`);
			const writeCaseCardData = useDataWriter({
				name: 'caseCard',
				schema: v.object({ status: v.picklist(['loading', 'loaded']) }),
			});
			useResponseStart(() => ({ op: { startedAt: 111 } }));
			// The finish hook computes over the start hook's contribution — the
			// metadata came back through the durable record log, not a closure.
			useResponseFinish(({ metadata, response }) => ({
				op: { finishedAt: 222 },
				elapsed: 222 - (metadata.op as { startedAt: number }).startedAt,
				totalTokens: response.usage.totalTokens,
			}));
			useTool({
				name: 'load_case',
				description: 'Load the case and stream a live card.',
				input: v.object({}),
				run: () => {
					writeCaseCardData({ status: 'loading' });
					writeCaseCardData({ status: 'loaded' });
					return 'ok';
				},
			});
			return 'Case agent.';
		}

		const coordinator = createNodeAgentCoordinator({
			submissions: executionStore.submissions,
			agents: [
				{
					name: 'assistant',
					definition: defineAgent(assistant),
				},
			],
			createContext: makeFauxCreateContext(provider),
			conversationStreamStore,
			attachmentStore,
		});

		await coordinator.admitDispatch(makeDispatchInput({ dispatchId: 'dispatch:output-1' }));
		await coordinator.waitForIdle();
		await coordinator.shutdown();

		// Reduce the REAL durable stream and project it — the same path a
		// snapshot read takes — so this pins record validity, placement,
		// reconciliation, and metadata merging end to end.
		const records = readDurableRecords(dbPath);
		const state = reduceConversationRecords(createReducedInstanceState(), records, 'end');
		const conversation = [...state.conversations.values()].find((c) => c.kind === 'root');
		expect(conversation).toBeDefined();
		if (!conversation) return;
		const messages = projectConversationUi(conversation, 'end').messages;
		const response = messages.find((message) => message.role === 'assistant');

		// One response message; both writes reconciled into one part, anchored
		// after the tool step that wrote them.
		expect(response?.parts).toMatchObject([
			{ type: 'dynamic-tool', toolCallId: 'tool-load-1', state: 'output-available', output: 'ok' },
			{ type: 'data-caseCard', data: { status: 'loaded' } },
			{ type: 'text', text: 'Done.' },
		]);
		// The metadata is exactly what the boundary hooks returned (start +
		// finish deep-merged); the finish hook read the start hook's value off
		// its context and the final aggregate usage off `response`.
		expect(response?.metadata).toMatchObject({
			op: { startedAt: 111, finishedAt: 222 },
			elapsed: 111,
		});
		expect(typeof response?.metadata?.totalTokens).toBe('number');
		expect(Object.keys(response?.metadata ?? {}).sort()).toEqual([
			'elapsed',
			'op',
			'totalTokens',
		]);
	});

	it('fails the submission when a finish hook throws — settled failed, no retry, no recovery', async () => {
		const dbPath = createTempDbPath();
		const { executionStore, conversationStreamStore, attachmentStore } =
			await connectSqlite(dbPath);
		const provider = createFauxProvider();
		provider.setResponses([fauxAssistantMessage('Fine.')]);

		function assistant() {
			useModel(`${provider.getModel().provider}/${provider.getModel().id}`);
			useResponseFinish(() => {
				throw new Error('finish boom');
			});
			return 'Case agent.';
		}

		const coordinator = createNodeAgentCoordinator({
			submissions: executionStore.submissions,
			agents: [
				{
					name: 'assistant',
					definition: defineAgent(assistant),
				},
			],
			createContext: makeFauxCreateContext(provider),
			conversationStreamStore,
			attachmentStore,
		});

		await coordinator.admitDispatch(makeDispatchInput({ dispatchId: 'dispatch:output-fail-1' }));
		await coordinator.waitForIdle();
		await coordinator.shutdown();

		// The throw converted to a durable failed settlement on the FIRST
		// attempt — boundary hooks are not retried and never enter recovery.
		const db = new DatabaseSync(dbPath);
		const submission = db
			.prepare('SELECT status, error, attempt_count FROM flue_agent_submissions')
			.get() as { status: string; error: string | null; attempt_count: number };
		db.close();
		expect(submission.status).toBe('settled');
		expect(submission.error).toMatch(
			/useResponseFinish callback \(hook #0 in declaration order\) threw: finish boom/,
		);
		expect(submission.attempt_count).toBe(1);
		// No metadata record was written for the failed response.
		expect(readDurableRecords(dbPath).some((record) => record.type === 'message_metadata')).toBe(
			false,
		);
	});

	it('fails the submission when a boundary hook is async — the sync contract has teeth', async () => {
		const dbPath = createTempDbPath();
		const { executionStore, conversationStreamStore, attachmentStore } =
			await connectSqlite(dbPath);
		const provider = createFauxProvider();
		provider.setResponses([fauxAssistantMessage('Fine.')]);

		function assistant() {
			useModel(`${provider.getModel().provider}/${provider.getModel().id}`);
			// @ts-expect-error response boundary hooks are synchronous observers
			useResponseStart(async () => ({ startedAt: Date.now() }));
			return 'Case agent.';
		}

		const coordinator = createNodeAgentCoordinator({
			submissions: executionStore.submissions,
			agents: [
				{
					name: 'assistant',
					definition: defineAgent(assistant),
				},
			],
			createContext: makeFauxCreateContext(provider),
			conversationStreamStore,
			attachmentStore,
		});

		await coordinator.admitDispatch(makeDispatchInput({ dispatchId: 'dispatch:output-async-1' }));
		await coordinator.waitForIdle();
		await coordinator.shutdown();

		const db = new DatabaseSync(dbPath);
		const submission = db
			.prepare('SELECT status, error, attempt_count FROM flue_agent_submissions')
			.get() as { status: string; error: string | null; attempt_count: number };
		db.close();
		expect(submission.status).toBe('settled');
		expect(submission.error).toMatch(
			/useResponseStart callback \(hook #0 in declaration order\) returned a promise/,
		);
		expect(submission.attempt_count).toBe(1);
	});
});
