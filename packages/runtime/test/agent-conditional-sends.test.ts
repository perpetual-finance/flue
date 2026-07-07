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
import type { ConversationRecord } from '../src/conversation-records.ts';
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
		provider: `agent-conditional-sends-test-${crypto.randomUUID()}`,
	});
	providers.push(provider);
	return provider;
}

function createTempDbPath(): string {
	const dir = mkdtempSync(join(tmpdir(), 'flue-agent-conditional-sends-'));
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

async function createRig(
	provider: FauxProviderRegistration,
	agents: Parameters<typeof createNodeAgentCoordinator>[0]['agents'],
) {
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

function makeAgent(provider: FauxProviderRegistration, onRender?: () => void) {
	return defineAgent(
		() => {
			onRender?.();
			return 'Base.';
		},
		{ model: `${provider.getModel().provider}/${provider.getModel().id}` },
	);
}

describe('conditional sends (uid)', () => {
	it('mints a prefixed uid at birth, returns it on every receipt, and records it durably', async () => {
		const provider = createFauxProvider();
		provider.setResponses([fauxAssistantMessage('one'), fauxAssistantMessage('two')]);
		const { coordinator, conversationStreamStore } = await createRig(provider, [
			{ name: 'assistant', definition: makeAgent(provider) },
		]);

		const created = await coordinator.admitDispatch(
			dispatchInput({ dispatchId: 'dispatch:create-1' }),
		);
		expect(created.kind).toBe('submission');
		expect(created.uid).toMatch(/^inst_/);
		await coordinator.waitForIdle();

		// An unconditional follow-up echoes the same uid.
		const followed = await coordinator.admitDispatch(
			dispatchInput({ dispatchId: 'dispatch:follow-2' }),
		);
		expect(followed.uid).toBe(created.uid);
		await coordinator.waitForIdle();
		await coordinator.shutdown();

		// The birth record is the mint site of record.
		const read = await conversationStreamStore.read('agents/assistant/instance-1', {
			offset: '-1',
		});
		const records = read.batches.flatMap((batch) => batch.records as ConversationRecord[]);
		const birth = records.find((record) => record.type === 'conversation_created');
		expect(birth).toMatchObject({ kind: 'root', uid: created.uid });
	});

	it('continues when the uid condition matches the incarnation', async () => {
		const provider = createFauxProvider();
		provider.setResponses([fauxAssistantMessage('one'), fauxAssistantMessage('two')]);
		let renders = 0;
		const { coordinator } = await createRig(provider, [
			{ name: 'assistant', definition: makeAgent(provider, () => renders++) },
		]);

		const created = await coordinator.admitDispatch(
			dispatchInput({ dispatchId: 'dispatch:create-1' }),
		);
		await coordinator.waitForIdle();
		const continued = await coordinator.admitDispatch(
			dispatchInput({ dispatchId: 'dispatch:continue-2', uid: created.uid }),
		);
		expect(continued.kind).toBe('submission');
		expect(continued.uid).toBe(created.uid);
		await coordinator.waitForIdle();
		await coordinator.shutdown();
		expect(renders).toBeGreaterThanOrEqual(2);
	});

	it('rejects a mismatched or absent-instance uid condition with 404, leaving nothing durable', async () => {
		const provider = createFauxProvider();
		provider.setResponses([fauxAssistantMessage('one')]);
		const { coordinator, executionStore } = await createRig(provider, [
			{ name: 'assistant', definition: makeAgent(provider) },
		]);

		// Condition on an instance that does not exist at all.
		await expect(
			coordinator.admitDispatch(
				dispatchInput({ dispatchId: 'dispatch:ghost-1', uid: 'inst_nonexistent' }),
			),
		).rejects.toMatchObject({ status: 404 });
		expect(await executionStore.submissions.getSubmission('dispatch:ghost-1')).toBeNull();

		// Condition with the wrong uid against an existing instance.
		const created = await coordinator.admitDispatch(
			dispatchInput({ dispatchId: 'dispatch:create-2' }),
		);
		await coordinator.waitForIdle();
		await expect(
			coordinator.admitDispatch(
				dispatchInput({ dispatchId: 'dispatch:stale-3', uid: `${created.uid}-stale` }),
			),
		).rejects.toMatchObject({ status: 404 });
		expect(await executionStore.submissions.getSubmission('dispatch:stale-3')).toBeNull();
		await coordinator.shutdown();
	});

	it('uid: null creates only when fresh; an existing instance rejects 409 with its uid in details', async () => {
		const provider = createFauxProvider();
		provider.setResponses([fauxAssistantMessage('one')]);
		const { coordinator, executionStore } = await createRig(provider, [
			{ name: 'assistant', definition: makeAgent(provider) },
		]);

		const created = await coordinator.admitDispatch(
			dispatchInput({ dispatchId: 'dispatch:create-1', uid: null }),
		);
		expect(created.kind).toBe('submission');
		expect(created.uid).toMatch(/^inst_/);
		await coordinator.waitForIdle();

		await expect(
			coordinator.admitDispatch(dispatchInput({ dispatchId: 'dispatch:again-2', uid: null })),
		).rejects.toMatchObject({
			status: 409,
			details: expect.stringContaining(created.uid as string),
			uid: created.uid,
		});
		expect(await executionStore.submissions.getSubmission('dispatch:again-2')).toBeNull();
		await coordinator.shutdown();
	});

	it('rejects the contradiction of a continue condition with creation data', async () => {
		const provider = createFauxProvider();
		provider.setResponses([fauxAssistantMessage('one')]);
		const { coordinator, executionStore } = await createRig(provider, [
			{ name: 'assistant', definition: makeAgent(provider) },
		]);

		await expect(
			coordinator.admitDispatch(
				dispatchInput({ dispatchId: 'dispatch:both-1', uid: 'inst_x', data: { seed: 1 } }),
			),
		).rejects.toMatchObject({
			status: 400,
			details: expect.stringContaining('cannot carry creation `data`'),
		});
		expect(await executionStore.submissions.getSubmission('dispatch:both-1')).toBeNull();
		await coordinator.shutdown();
	});

	it('unconditional sends keep todays semantics: data seeds creation, is ignored on existing', async () => {
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

		const created = await coordinator.admitDispatch(
			dispatchInput({ dispatchId: 'dispatch:create-1', data: { issue: 7 } }),
		);
		await coordinator.waitForIdle();
		// Unconditional send with data to the EXISTING instance: delivered, seed
		// ignored — the channel row of the conditional-send model.
		const followed = await coordinator.admitDispatch(
			dispatchInput({ dispatchId: 'dispatch:follow-2', data: { issue: 99 } }),
		);
		expect(followed.kind).toBe('submission');
		expect(followed.uid).toBe(created.uid);
		await coordinator.waitForIdle();
		await coordinator.shutdown();

		expect(seen.length).toBeGreaterThanOrEqual(2);
		for (const value of seen) expect(value).toEqual({ issue: 7 });
	});
});
