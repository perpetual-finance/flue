import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
	type FauxProviderRegistration,
	fauxAssistantMessage,
	fauxToolCall,
	registerFauxProvider,
} from '@earendil-works/pi-ai/compat';
import { afterEach, describe, expect, it } from 'vitest';
import { defineAgent } from '../src/agent-definition.ts';
import { renderWithFrame } from '../src/hooks/frame.ts';
import { renderAgentFunctionWithStructure } from '../src/hooks/render.ts';
import { useDelivery } from '../src/hooks/use-delivery.ts';
import { useTool } from '../src/hooks/use-tool.ts';
import { createFlueContext, type DispatchInput } from '../src/internal.ts';
import { createNodeAgentCoordinator } from '../src/node/agent-coordinator.ts';
import { sqlite } from '../src/node/agent-execution-store.ts';
import {
	type AgentSubmissionInput,
	createAgentSubmissionSessionHandler,
} from '../src/runtime/agent-submissions.ts';
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
		provider: `agent-delivery-test-${crypto.randomUUID()}`,
	});
	providers.push(provider);
	return provider;
}

function createTempDbPath(): string {
	const dir = mkdtempSync(join(tmpdir(), 'flue-agent-delivery-'));
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

const CONFIG = { model: 'faux/agent-delivery' };

describe('useDelivery()', () => {
	it('is unavailable in subagent renders', () => {
		expect(() =>
			renderWithFrame(
				() => {
					useDelivery();
				},
				undefined,
				'subagent',
			),
		).toThrow(/not available in a subagent render/);
	});

	it('returns undefined when no delivered message triggered the run', () => {
		let seen: DeliveredMessage | undefined | 'unset' = 'unset';
		renderAgentFunctionWithStructure(() => {
			seen = useDelivery();
			return 'Base.';
		}, CONFIG);
		expect(seen).toBeUndefined();
	});

	it('exposes the dispatched signal, attributes included, to every render of the run', async () => {
		const dbPath = createTempDbPath();
		const adapter = sqlite(dbPath);
		await adapter.migrate?.();
		const { executionStore, conversationStreamStore, attachmentStore } = await adapter.connect();
		const provider = createFauxProvider();
		provider.setResponses([
			fauxAssistantMessage(fauxToolCall('load_issue', {}, { id: 'tool-load-1' }), {
				stopReason: 'toolUse',
			}),
			fauxAssistantMessage('Triaged.'),
		]);

		const message: DeliveredMessage = {
			kind: 'signal',
			type: 'issue.triage',
			body: 'Triage issue #42.',
			attributes: { issue: '42' },
		};
		const rendersSaw: Array<DeliveredMessage | undefined> = [];
		let toolSaw: DeliveredMessage | undefined;

		function assistant() {
			const delivery = useDelivery();
			rendersSaw.push(delivery);
			useTool({
				name: 'load_issue',
				description: 'Load the issue named by the dispatch.',
				run: () => {
					// The tool reads the payload from code — no model echo involved.
					toolSaw = delivery;
					return 'ok';
				},
			});
			return 'Triage agent.';
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

		await coordinator.admitDispatch({
			dispatchId: 'dispatch:delivery-1',
			agent: 'assistant',
			id: 'instance-1',
			message,
			acceptedAt: new Date().toISOString(),
		} satisfies DispatchInput);
		await coordinator.waitForIdle();
		await coordinator.shutdown();

		// The value survived the durable payload round trip and was identical in
		// every render of the run — including the re-render before turn two.
		expect(toolSaw).toEqual(message);
		expect(rendersSaw.length).toBeGreaterThanOrEqual(2);
		for (const seen of rendersSaw) expect(seen).toEqual(message);
	});

	it('delivers the same signal shape for a direct submission — transports are symmetric', async () => {
		const provider = createFauxProvider();
		provider.setResponses([fauxAssistantMessage('Noted.')]);

		const message: DeliveredMessage = {
			kind: 'signal',
			type: 'issue.triage',
			body: 'Triage issue #7.',
			attributes: { issue: '7' },
		};
		let seen: DeliveredMessage | undefined;

		function assistant() {
			seen = useDelivery();
			return 'Triage agent.';
		}
		const agent = defineAgent(assistant, {
			model: `${provider.getModel().provider}/${provider.getModel().id}`,
		});

		const input: AgentSubmissionInput = {
			kind: 'direct',
			submissionId: `direct:${crypto.randomUUID()}`,
			agent: 'assistant',
			id: 'instance-direct',
			message,
			acceptedAt: '2026-07-06T00:00:00.000Z',
		};
		const ctx = createFlueContext({
			id: input.id,
			env: {},
			agentConfig: {
				subagents: {},
				resolveModel: () => provider.getModel(),
			},
			createDefaultEnv: async () => createNoopSessionEnv({ cwd: '/' }),
		});
		await createAgentSubmissionSessionHandler(agent, input, (s) =>
			s.processSubmissionInput(input, {
				submissionAttempt: { submissionId: input.submissionId, attemptId: 'attempt-1' },
			}),
		)(ctx);

		expect(seen).toEqual(message);
	});
});
