import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
	type FauxProviderRegistration,
	fauxAssistantMessage,
	registerFauxProvider,
} from '@earendil-works/pi-ai/compat';
import * as v from 'valibot';
import { afterEach, describe, expect, it } from 'vitest';
import { defineAgent } from '../src/agent-definition.ts';
import {
	projectAgentConversationBatch,
	projectAgentConversationSnapshot,
} from '../src/conversation-public.ts';
import type { ConversationRecord } from '../src/conversation-records.ts';
import {
	createReducedInstanceState,
	reduceConversationRecords,
} from '../src/conversation-reducer.ts';
import {
	renderAgentFunctionWithStructure,
	resolveSubagentDefinition,
} from '../src/hooks/render.ts';
import { useInitialData } from '../src/hooks/use-initial-data.ts';
import { createFlueContext, type DispatchInput } from '../src/internal.ts';
import { createNodeAgentCoordinator } from '../src/node/agent-coordinator.ts';
import { sqlite } from '../src/node/agent-execution-store.ts';
import type { CreateAgentContextFn } from '../src/runtime/handle-agent.ts';
import type { DeliveredMessage } from '../src/types.ts';
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
		provider: `agent-initial-data-test-${crypto.randomUUID()}`,
	});
	providers.push(provider);
	return provider;
}

function createTempDbPath(): string {
	const dir = mkdtempSync(join(tmpdir(), 'flue-agent-initial-data-'));
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

async function createRig(provider: FauxProviderRegistration, agents: Parameters<typeof createNodeAgentCoordinator>[0]['agents']) {
	const dbPath = createTempDbPath();
	const adapter = sqlite(dbPath);
	await adapter.migrate?.();
	const { executionStore, conversationStreamStore, attachmentStore } = await adapter.connect();
	const coordinator = createNodeAgentCoordinator({
		submissions: executionStore.submissions,
		agents,
		createContext: makeFauxCreateContext(provider),
		conversationStreamStore,
		attachmentStore,
	});
	return { coordinator, executionStore, conversationStreamStore };
}

function dispatchInput(overrides: Partial<DispatchInput> & { dispatchId: string }): DispatchInput {
	return {
		agent: 'assistant',
		id: 'instance-1',
		message: { kind: 'user', body: 'hello' } satisfies DeliveredMessage,
		acceptedAt: new Date().toISOString(),
		...overrides,
	};
}

const CONFIG = { model: 'faux/agent-initial-data' };

describe('useInitialData()', () => {
	it('returns undefined on a bare render and the backed value from render state', () => {
		let bare: unknown = 'sentinel';
		renderAgentFunctionWithStructure(() => {
			bare = useInitialData();
			return 'Base.';
		}, CONFIG);
		expect(bare).toBeUndefined();

		let seen: unknown;
		renderAgentFunctionWithStructure(
			() => {
				seen = useInitialData<{ issue: number }>();
				return 'Base.';
			},
			CONFIG,
			{ snapshot: new Map(), store: undefined, initialData: { issue: 17307 } },
		);
		expect(seen).toEqual({ issue: 17307 });
	});

	it('returns undefined in a subagent render — delegates have no creation data', () => {
		let seen: unknown = 'sentinel';
		resolveSubagentDefinition({
			name: 'worker',
			description: 'Isolated delegate.',
			agent: () => {
				seen = useInitialData();
				return 'Delegate.';
			},
		});
		expect(seen).toBeUndefined();
	});

	it('rejects a defineAgent input that is not a valibot schema', () => {
		expect(() =>
			defineAgent(() => 'Base.', { model: 'faux/x', input: {} as never }),
		).toThrow('config.input must be a Valibot schema');
	});

	it('validates, records, and serves creation data across submissions — schema-parsed output included', async () => {
		const provider = createFauxProvider();
		provider.setResponses([fauxAssistantMessage('one'), fauxAssistantMessage('two')]);
		// The optional-with-default field proves renders see the schema-PARSED
		// output (and that the parsed value, not the raw wire value, is what
		// the birth record stores for later submissions).
		const input = v.object({
			issue: v.pipe(v.number(), v.integer()),
			priority: v.optional(v.string(), 'p2'),
		});
		const seen: unknown[] = [];
		const agent = defineAgent(
			() => {
				seen.push(useInitialData<v.InferOutput<typeof input>>());
				return 'Base.';
			},
			{ model: `${provider.getModel().provider}/${provider.getModel().id}`, input },
		);
		const { coordinator } = await createRig(provider, [{ name: 'assistant', definition: agent }]);

		await coordinator.admitDispatch(
			dispatchInput({ dispatchId: 'dispatch:create-1', initialData: { issue: 17307 } }),
		);
		await coordinator.waitForIdle();
		// Second submission carries no data — the recorded value serves it.
		await coordinator.admitDispatch(dispatchInput({ dispatchId: 'dispatch:follow-2' }));
		await coordinator.waitForIdle();
		await coordinator.shutdown();

		expect(seen.length).toBeGreaterThanOrEqual(2);
		for (const value of seen) expect(value).toEqual({ issue: 17307, priority: 'p2' });
	});

	it('rejects a creating dispatch missing required data at admission, leaving nothing durable', async () => {
		const provider = createFauxProvider();
		provider.setResponses([fauxAssistantMessage('created')]);
		const input = v.object({ issue: v.number() });
		let renders = 0;
		let seen: unknown;
		const agent = defineAgent(
			() => {
				renders += 1;
				seen = useInitialData<v.InferOutput<typeof input>>();
				return 'Base.';
			},
			{ model: `${provider.getModel().provider}/${provider.getModel().id}`, input },
		);
		const { coordinator, executionStore } = await createRig(provider, [
			{ name: 'assistant', definition: agent },
		]);

		await expect(
			coordinator.admitDispatch(dispatchInput({ dispatchId: 'dispatch:bare-1' })),
		).rejects.toMatchObject({
			status: 400,
			details: expect.stringContaining('requires creation data matching its input schema'),
		});
		// Rejected before durable admission and before any render.
		expect(renders).toBe(0);
		expect(await executionStore.submissions.getSubmission('dispatch:bare-1')).toBeNull();

		// The rejected attempt created nothing: the same instance can be created
		// properly afterwards.
		await coordinator.admitDispatch(
			dispatchInput({ dispatchId: 'dispatch:create-2', initialData: { issue: 7 } }),
		);
		await coordinator.waitForIdle();
		await coordinator.shutdown();
		expect(seen).toEqual({ issue: 7 });
	});

	it('accepts absence when the schema does, and ignores data sent to an existing instance', async () => {
		const provider = createFauxProvider();
		provider.setResponses([fauxAssistantMessage('one'), fauxAssistantMessage('two')]);
		const input = v.optional(v.object({ issue: v.number() }));
		const seen: unknown[] = [];
		const agent = defineAgent(
			() => {
				seen.push(useInitialData<v.InferOutput<typeof input>>());
				return 'Base.';
			},
			{ model: `${provider.getModel().provider}/${provider.getModel().id}`, input },
		);
		const { coordinator } = await createRig(provider, [{ name: 'assistant', definition: agent }]);

		// Creation without data: the optional schema accepts it.
		await coordinator.admitDispatch(dispatchInput({ dispatchId: 'dispatch:optional-1' }));
		await coordinator.waitForIdle();
		// Data on an existing instance is ignored, not adopted.
		await coordinator.admitDispatch(
			dispatchInput({ dispatchId: 'dispatch:late-2', initialData: { issue: 99 } }),
		);
		await coordinator.waitForIdle();
		await coordinator.shutdown();

		expect(seen.length).toBeGreaterThanOrEqual(2);
		for (const value of seen) expect(value).toBeUndefined();
	});

	it('records untyped data without a schema, and keeps it off the client wire', async () => {
		const provider = createFauxProvider();
		provider.setResponses([fauxAssistantMessage('done')]);
		let seen: unknown;
		const agent = defineAgent(
			() => {
				seen = useInitialData();
				return 'Base.';
			},
			{ model: `${provider.getModel().provider}/${provider.getModel().id}` },
		);
		const { coordinator, conversationStreamStore } = await createRig(provider, [
			{ name: 'assistant', definition: agent },
		]);

		const marker = 'INITIAL-DATA-MARKER-9c41';
		await coordinator.admitDispatch(
			dispatchInput({ dispatchId: 'dispatch:untyped-1', initialData: { note: marker } }),
		);
		await coordinator.waitForIdle();
		await coordinator.shutdown();

		expect(seen).toEqual({ note: marker });

		// Privacy pin: the durable records carry the data (server-side), but
		// neither the snapshot projection nor the chunk stream — the only
		// client-served shapes — ever includes it.
		const read = await conversationStreamStore.read('agents/assistant/instance-1', {
			offset: '-1',
		});
		let state = createReducedInstanceState();
		const chunks: unknown[] = [];
		let sawRecordWithData = false;
		for (const batch of read.batches) {
			const records = batch.records as ConversationRecord[];
			const previousState = state;
			state = reduceConversationRecords(state, records, batch.offset);
			for (const record of records) {
				if (JSON.stringify(record).includes(marker)) sawRecordWithData = true;
			}
			chunks.push(
				...projectAgentConversationBatch({
					state,
					previousState,
					records,
					batchOrdinal: Number.parseInt(batch.offset, 10),
				}),
			);
		}
		expect(sawRecordWithData).toBe(true);
		expect(JSON.stringify(chunks)).not.toContain(marker);
		expect(JSON.stringify(projectAgentConversationSnapshot(state))).not.toContain(marker);
	});
});
