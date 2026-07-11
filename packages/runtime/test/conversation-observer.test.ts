import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
	type FauxProviderRegistration,
	fauxAssistantMessage,
	fauxToolCall,
	registerFauxProvider,
} from '@earendil-works/pi-ai/compat';
import * as v from 'valibot';
import { afterEach, describe, expect, it } from 'vitest';
import { useDataWriter } from '../src/hooks/use-data-writer.ts';
import { useModel } from '../src/hooks/use-model.ts';
import { useResponseFinish } from '../src/hooks/use-response-finish.ts';
import { useTool } from '../src/hooks/use-tool.ts';
import {
	agentStreamPath,
	type ConversationStreamChunk,
	createFlueContext,
	createNodeAgentCoordinator,
	observeSubmissionSettlement,
	readSubmissionReply,
} from '../src/internal.ts';
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
		provider: `conversation-observer-test-${crypto.randomUUID()}`,
	});
	providers.push(provider);
	return provider;
}

function createTempDbPath(): string {
	const dir = mkdtempSync(join(tmpdir(), 'flue-conversation-observer-'));
	tempDirs.push(dir);
	return join(dir, 'agent.db');
}

function makeFauxCreateContext(provider: FauxProviderRegistration): CreateAgentContextFn {
	return ({ id, agentName, request, initialEventIndex, dispatchId }) =>
		createFlueContext({
			id,
			agentName,
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

/** Coordinator over a real sqlite store running one "assistant" agent. */
async function setupCoordinator(
	provider: FauxProviderRegistration,
	assistant: () => string | undefined,
) {
	const adapter = sqlite(createTempDbPath());
	await adapter.migrate?.();
	const stores = await adapter.connect();
	if (!stores.conversationStreamStore || !stores.attachmentStore) {
		throw new Error('sqlite adapter did not provide conversation stores');
	}
	const conversationStreamStore = stores.conversationStreamStore;
	const coordinator = createNodeAgentCoordinator({
		submissions: stores.executionStore.submissions,
		agents: [
			{
				name: 'assistant',
				agent: () => {
					useModel(`${provider.getModel().provider}/${provider.getModel().id}`);
					return assistant();
				},
			},
		],
		createContext: makeFauxCreateContext(provider),
		conversationStreamStore,
		attachmentStore: stores.attachmentStore,
	});
	return { coordinator, conversationStreamStore };
}

describe('observeSubmissionSettlement + readSubmissionReply', () => {
	it('resolves a direct submission settlement and reads its text reply', async () => {
		const provider = createFauxProvider();
		provider.setResponses([fauxAssistantMessage('The nightly report is ready.')]);
		const { coordinator, conversationStreamStore } = await setupCoordinator(
			provider,
			() => 'Reply when prompted.',
		);

		const admit = coordinator.createAdmission('assistant', 'inst-observer-1');
		const receipt = await admit({ kind: 'user', body: 'Run the nightly report.' });
		expect(receipt.uid).toEqual(expect.any(String));

		const path = agentStreamPath('assistant', 'inst-observer-1');
		const seen: ConversationStreamChunk['type'][] = [];
		const settlement = await observeSubmissionSettlement({
			store: conversationStreamStore,
			path,
			submissionId: receipt.submissionId,
			offset: receipt.offset,
			onEvent: (chunk) => seen.push(chunk.type),
		});
		expect(settlement).toEqual({ outcome: 'completed' });
		// The observation streamed the projected chunks along the way,
		// terminating with this submission's settlement.
		expect(seen).toContain('submission-settled');
		expect(seen.some((type) => type === 'message-appended' || type === 'message-started')).toBe(
			true,
		);

		const reply = await readSubmissionReply({
			store: conversationStreamStore,
			path,
			submissionId: receipt.submissionId,
		});
		expect(reply.text).toBe('The nightly report is ready.');
		expect(reply.data).toEqual({});
		expect(reply.metadata).toBeUndefined();

		await coordinator.shutdown();
	});

	it('reads named data parts and agent-authored metadata off the reply', async () => {
		const provider = createFauxProvider();
		provider.setResponses([
			fauxAssistantMessage(fauxToolCall('publish_report', {}, { id: 'tool-obs-1' }), {
				stopReason: 'toolUse',
			}),
			fauxAssistantMessage('Report published.'),
		]);

		function assistant() {
			const writeReportData = useDataWriter({
				name: 'report',
				schema: v.object({ status: v.string() }),
			});
			useResponseFinish(() => ({ reviewedBy: 'observer-test' }));
			useTool({
				name: 'publish_report',
				description: 'Publish the report and stream its status.',
				run: async () => {
					writeReportData({ status: 'published' });
					return 'done';
				},
			});
			return 'Call publish_report, then confirm.';
		}

		const { coordinator, conversationStreamStore } = await setupCoordinator(provider, assistant);
		const admit = coordinator.createAdmission('assistant', 'inst-observer-2');
		const receipt = await admit({ kind: 'user', body: 'Publish.' });
		const path = agentStreamPath('assistant', 'inst-observer-2');
		const settlement = await observeSubmissionSettlement({
			store: conversationStreamStore,
			path,
			submissionId: receipt.submissionId,
			offset: receipt.offset,
		});
		expect(settlement.outcome).toBe('completed');

		const reply = await readSubmissionReply({
			store: conversationStreamStore,
			path,
			submissionId: receipt.submissionId,
		});
		expect(reply.text).toBe('Report published.');
		expect(reply.data).toEqual({ report: [{ status: 'published' }] });
		expect(reply.metadata).toMatchObject({ reviewedBy: 'observer-test' });

		await coordinator.shutdown();
	});

	it('scopes the reply to the requested submission across multiple prompts', async () => {
		const provider = createFauxProvider();
		provider.setResponses([
			fauxAssistantMessage('First reply.'),
			fauxAssistantMessage('Second reply.'),
		]);
		const { coordinator, conversationStreamStore } = await setupCoordinator(
			provider,
			() => 'Reply when prompted.',
		);
		const admit = coordinator.createAdmission('assistant', 'inst-observer-3');
		const path = agentStreamPath('assistant', 'inst-observer-3');

		const first = await admit({ kind: 'user', body: 'One.' });
		await observeSubmissionSettlement({
			store: conversationStreamStore,
			path,
			submissionId: first.submissionId,
			offset: first.offset,
		});
		const second = await admit({ kind: 'user', body: 'Two.' });
		await observeSubmissionSettlement({
			store: conversationStreamStore,
			path,
			submissionId: second.submissionId,
			offset: second.offset,
		});

		const firstReply = await readSubmissionReply({
			store: conversationStreamStore,
			path,
			submissionId: first.submissionId,
		});
		const secondReply = await readSubmissionReply({
			store: conversationStreamStore,
			path,
			submissionId: second.submissionId,
		});
		expect(firstReply.text).toBe('First reply.');
		expect(secondReply.text).toBe('Second reply.');

		await coordinator.shutdown();
	});

	it('threads uid conditions through the admission options object', async () => {
		const provider = createFauxProvider();
		provider.setResponses([fauxAssistantMessage('one'), fauxAssistantMessage('two')]);
		const { coordinator, conversationStreamStore } = await setupCoordinator(
			provider,
			() => 'Reply when prompted.',
		);
		const admit = coordinator.createAdmission('assistant', 'inst-observer-4');
		const path = agentStreamPath('assistant', 'inst-observer-4');

		const first = await admit({ kind: 'user', body: 'Create.' }, { uid: null });
		await observeSubmissionSettlement({
			store: conversationStreamStore,
			path,
			submissionId: first.submissionId,
			offset: first.offset,
		});

		// create-only against the now-existing instance rejects…
		await expect(admit({ kind: 'user', body: 'Again.' }, { uid: null })).rejects.toThrow();
		// …while continue-only with the known uid succeeds.
		const second = await admit({ kind: 'user', body: 'Continue.' }, { uid: first.uid as string });
		const settlement = await observeSubmissionSettlement({
			store: conversationStreamStore,
			path,
			submissionId: second.submissionId,
			offset: second.offset,
		});
		expect(settlement.outcome).toBe('completed');

		await coordinator.shutdown();
	});
});
