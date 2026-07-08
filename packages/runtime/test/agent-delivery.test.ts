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
import { renderAgentFunctionWithStructure } from '../src/hooks/render.ts';
import { useDelivery } from '../src/hooks/use-delivery.ts';
import { useSubagent } from '../src/hooks/use-subagent.ts';
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
	it('throws when no delivery backs the render, and reads one supplied to a direct render', () => {
		// Inside the runtime every run is triggered by a delivered message, so
		// absence is an error, not undefined.
		expect(() =>
			renderAgentFunctionWithStructure(() => {
				useDelivery();
				return 'Base.';
			}, CONFIG),
		).toThrow(/no delivered message behind this render/);

		// Direct render harnesses (tests, tooling) supply one via render state.
		const message: DeliveredMessage = { kind: 'user', body: 'Hello.' };
		let seen: DeliveredMessage | undefined;
		renderAgentFunctionWithStructure(
			() => {
				seen = useDelivery();
				return 'Base.';
			},
			CONFIG,
			{ snapshot: new Map(), store: undefined, delivery: message },
		);
		expect(seen).toEqual(message);
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
		const rendersSaw: DeliveredMessage[] = [];
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

		// The value survived the durable payload round trip, and with no joins
		// or appends the cursor never advanced — every render of the response
		// read the waking delivery, including the re-render before turn two.
		expect(toolSaw).toEqual(message);
		expect(rendersSaw.length).toBeGreaterThanOrEqual(2);
		for (const seen of rendersSaw) expect(seen).toEqual(message);
	});

	it('gives a delegate render the parent task prompt as its delivery', async () => {
		const dbPath = createTempDbPath();
		const adapter = sqlite(dbPath);
		await adapter.migrate?.();
		const { executionStore, conversationStreamStore, attachmentStore } = await adapter.connect();
		const provider = createFauxProvider();
		provider.setResponses([
			// Parent turn 1: delegate to the summarizer.
			fauxAssistantMessage(
				fauxToolCall(
					'task',
					{ prompt: 'Summarize the case.', agent: 'summarizer' },
					{ id: 'tool:task-1' },
				),
				{ stopReason: 'toolUse' },
			),
			// Child turn.
			fauxAssistantMessage('CHILD-DONE'),
			// Parent turn 2.
			fauxAssistantMessage('Done.'),
		]);

		let delegateSaw: DeliveredMessage | undefined;
		function Summarizer() {
			delegateSaw = useDelivery();
			return 'You summarize support cases.';
		}
		function assistant() {
			useSubagent({
				name: 'summarizer',
				description: 'Summarizes one support case.',
				agent: Summarizer,
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

		await coordinator.admitDispatch({
			dispatchId: 'dispatch:delivery-delegate-1',
			agent: 'assistant',
			id: 'instance-2',
			message: { kind: 'user', body: 'Handle this case.' },
			acceptedAt: new Date().toISOString(),
		} satisfies DispatchInput);
		await coordinator.waitForIdle();
		await coordinator.shutdown();

		// The delegate's delivery is the parent's TASK PROMPT — not the
		// dispatch that triggered the parent.
		expect(delegateSaw).toEqual({ kind: 'user', body: 'Summarize the case.' });
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
