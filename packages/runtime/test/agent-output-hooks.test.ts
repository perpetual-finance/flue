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
import { useMessageData } from '../src/hooks/use-message-data.ts';
import { useMessageMetadata } from '../src/hooks/use-message-metadata.ts';
import { useTool } from '../src/hooks/use-tool.ts';
import { createFlueContext, type DispatchInput } from '../src/internal.ts';
import { createAgentOutputChannel } from '../src/message-output.ts';
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

describe('useMessageData()', () => {
	it('rejects duplicate names in one render', () => {
		expect(() =>
			renderAgentFunctionWithStructure(() => {
				useMessageData({ name: 'caseCard' });
				useMessageData({ name: 'caseCard' });
				return 'Base.';
			}, CONFIG),
		).toThrow(/Duplicate useMessageData name "caseCard"/);
	});

	it('is unavailable in subagent renders', () => {
		expect(() =>
			renderWithFrame(
				() => {
					useMessageData({ name: 'caseCard' });
				},
				undefined,
				'subagent',
			),
		).toThrow(/not available in a subagent render/);
	});

	it('rejects writes made during render', () => {
		expect(() =>
			renderAgentFunctionWithStructure(() => {
				const writeCaseCardData = useMessageData({ name: 'caseCard' });
				writeCaseCardData({ status: 'loading' });
				return 'Base.';
			}, CONFIG),
		).toThrow(/written during render/);
	});

	it('throws on write when no durable runtime backs the render', () => {
		let writeCaseCardData: ((data: unknown) => void) | undefined;
		renderAgentFunctionWithStructure(() => {
			writeCaseCardData = useMessageData({ name: 'caseCard' });
			return 'Base.';
		}, CONFIG);
		expect(() => writeCaseCardData?.({ status: 'loading' })).toThrow(/no durable runtime/);
	});

	it('validates writes against the schema and JSON-normalizes them', () => {
		const channel = createAgentOutputChannel();
		const written: Array<{ name: string; data: unknown }> = [];
		channel.connect((name, data) => written.push({ name, data }));
		let writeCaseCardData: ((data: unknown) => void) | undefined;
		renderAgentFunctionWithStructure(
			() => {
				// Widened on purpose: the test feeds schema-invalid values through.
				writeCaseCardData = useMessageData({
					name: 'caseCard',
					schema: v.object({ status: v.picklist(['loading', 'loaded']) }),
				}) as (data: unknown) => void;
				return 'Base.';
			},
			CONFIG,
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
				if (mount) useMessageData({ name: 'caseCard' });
				return 'Base.';
			}, CONFIG).structure;
		expect(() => assertRenderStructureInvariance(render(true), render(false))).toThrow(
			/message data removed caseCard/,
		);
	});
});

describe('useMessageMetadata()', () => {
	it('rejects unknown lifecycle points', () => {
		expect(() =>
			renderAgentFunctionWithStructure(() => {
				// @ts-expect-error point must be 'start' or 'finish'
				useMessageMetadata('step', () => ({}));
				return 'Base.';
			}, CONFIG),
		).toThrow(/point must be 'start' or 'finish'/);
	});

	it('is unavailable in subagent renders', () => {
		expect(() =>
			renderWithFrame(
				() => {
					useMessageMetadata('start', () => ({}));
				},
				undefined,
				'subagent',
			),
		).toThrow(/not available in a subagent render/);
	});

	it('hands the render\'s producers to the output channel in call order', () => {
		const channel = createAgentOutputChannel();
		renderAgentFunctionWithStructure(
			() => {
				useMessageMetadata('start', () => ({ a: 1 }));
				useMessageMetadata('finish', () => ({ b: 2 }));
				useMessageMetadata('finish', () => ({ c: 3 }));
				return 'Base.';
			},
			CONFIG,
			{ snapshot: new Map(), store: undefined, output: channel },
		);
		expect(channel.producers.start).toHaveLength(1);
		expect(channel.producers.finish).toHaveLength(2);
	});
});

describe('output hooks end to end (node coordinator, faux provider)', () => {
	it('streams live data parts onto the response message and stamps start/finish metadata', async () => {
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
			const writeCaseCardData = useMessageData({
				name: 'caseCard',
				schema: v.object({ status: v.picklist(['loading', 'loaded']) }),
			});
			useMessageMetadata('start', () => ({ op: { startedAt: 111 } }));
			useMessageMetadata('finish', (event) => ({
				op: { finishedAt: 222 },
				totalTokens: event.usage.totalTokens,
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
					definition: defineAgent(assistant, {
						model: `${provider.getModel().provider}/${provider.getModel().id}`,
					}),
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
		// Start + finish metadata deep-merged; the finish event carried the
		// response's aggregate usage; server keys still authored by the server.
		expect(response?.metadata).toMatchObject({
			op: { startedAt: 111, finishedAt: 222 },
		});
		expect(response?.metadata?.totalTokens).toBe(response?.metadata?.usage?.totalTokens);
		expect(typeof response?.metadata?.timestamp).toBe('string');
	});

	it('fails the submission when a finish producer throws — settled failed, no retry, no recovery', async () => {
		const dbPath = createTempDbPath();
		const { executionStore, conversationStreamStore, attachmentStore } =
			await connectSqlite(dbPath);
		const provider = createFauxProvider();
		provider.setResponses([fauxAssistantMessage('Fine.')]);

		function assistant() {
			useMessageMetadata('finish', () => {
				throw new Error('finish boom');
			});
			return 'Case agent.';
		}

		const coordinator = createNodeAgentCoordinator({
			submissions: executionStore.submissions,
			agents: [
				{
					name: 'assistant',
					definition: defineAgent(assistant, {
						model: `${provider.getModel().provider}/${provider.getModel().id}`,
					}),
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
		// attempt — producers are not retried and never enter recovery.
		const db = new DatabaseSync(dbPath);
		const submission = db
			.prepare('SELECT status, error, attempt_count FROM flue_agent_submissions')
			.get() as { status: string; error: string | null; attempt_count: number };
		db.close();
		expect(submission.status).toBe('settled');
		expect(submission.error).toMatch(/useMessageMetadata\('finish'\) producer threw: finish boom/);
		expect(submission.attempt_count).toBe(1);
		// No metadata record was written for the failed response.
		expect(readDurableRecords(dbPath).some((record) => record.type === 'message_metadata')).toBe(
			false,
		);
	});
});
