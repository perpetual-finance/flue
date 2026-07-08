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
import { afterEach, describe, expect, it } from 'vitest';
import { defineAgent } from '../src/agent-definition.ts';
import type { ConversationRecord } from '../src/conversation-records.ts';
import {
	createReducedInstanceState,
	getActiveConversationPath,
	reduceConversationRecords,
} from '../src/conversation-reducer.ts';
import { renderWithFrame } from '../src/hooks/frame.ts';
import {
	assertRenderStructureInvariance,
	renderAgentFunctionWithStructure,
} from '../src/hooks/render.ts';
import { useState } from '../src/hooks/state.ts';
import { useDelivery } from '../src/hooks/use-delivery.ts';
import { useEffect } from '../src/hooks/use-effect.ts';
import { useTool } from '../src/hooks/use-tool.ts';
import { createFlueContext, type DispatchInput } from '../src/internal.ts';
import { createNodeAgentCoordinator } from '../src/node/agent-coordinator.ts';
import { sqlite } from '../src/node/agent-execution-store.ts';
import {
	type AgentSubmissionInput,
	createAgentSubmissionSessionHandler,
} from '../src/runtime/agent-submissions.ts';
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
		provider: `agent-effect-test-${crypto.randomUUID()}`,
	});
	providers.push(provider);
	return provider;
}

function createTempDbPath(): string {
	const dir = mkdtempSync(join(tmpdir(), 'flue-agent-effect-'));
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

function makeCoordinator(
	provider: FauxProviderRegistration,
	stores: Awaited<ReturnType<typeof connectSqlite>>,
	assistant: () => string | undefined,
) {
	return createNodeAgentCoordinator({
		submissions: stores.executionStore.submissions,
		agents: [
			{
				name: 'assistant',
				definition: defineAgent(assistant, {
					model: `${provider.getModel().provider}/${provider.getModel().id}`,
				}),
			},
		],
		createContext: makeFauxCreateContext(provider),
		conversationStreamStore: stores.conversationStreamStore,
		attachmentStore: stores.attachmentStore,
	});
}

async function dispatchAndSettle(
	coordinator: ReturnType<typeof makeCoordinator>,
	body: string,
	id = 'instance-1',
): Promise<void> {
	await coordinator.admitDispatch({
		dispatchId: `dispatch-${crypto.randomUUID()}`,
		agent: 'assistant',
		id,
		message: { kind: 'user', body },
		acceptedAt: new Date().toISOString(),
	} satisfies DispatchInput);
	await coordinator.waitForIdle();
}

const CONFIG = { model: 'faux/agent-effect' };

describe('useEffect()', () => {
	it('requires a run function and a deps array', () => {
		expect(() =>
			renderAgentFunctionWithStructure(() => {
				(useEffect as unknown as (run: unknown) => void)(() => {});
				return 'Base.';
			}, CONFIG),
		).toThrow(/requires a deps array/);
		expect(() =>
			renderAgentFunctionWithStructure(() => {
				(useEffect as unknown as (run: unknown, deps: unknown) => void)('nope', []);
				return 'Base.';
			}, CONFIG),
		).toThrow(/takes the run callback as its first argument/);
	});

	it('rejects non-JSON deps values', () => {
		expect(() =>
			renderAgentFunctionWithStructure(() => {
				useEffect(() => {}, [() => {}]);
				return 'Base.';
			}, CONFIG),
		).toThrow(/deps must be JSON values/);
	});

	it('is unavailable in subagent renders', () => {
		expect(() =>
			renderWithFrame(
				() => {
					useEffect(() => {}, []);
				},
				undefined,
				'subagent',
			),
		).toThrow(/not available in a subagent render/);
	});

	it('effect count joins the structural invariance fingerprint', () => {
		const one = renderAgentFunctionWithStructure(() => {
			useEffect(() => {}, []);
			return 'Base.';
		}, CONFIG).structure;
		const two = renderAgentFunctionWithStructure(() => {
			useEffect(() => {}, []);
			useEffect(() => {}, []);
			return 'Base.';
		}, CONFIG).structure;
		expect(() => assertRenderStructureInvariance(one, two)).toThrow(
			/effect count changed \(1 → 2\)/,
		);
	});

	it('runs before turn one: an appended signal reaches the model with the input, durably ordered', async () => {
		const dbPath = createTempDbPath();
		const stores = await connectSqlite(dbPath);
		const provider = createFauxProvider();

		let turnOneTexts: string[] | undefined;
		provider.setResponses([
			(context) => {
				turnOneTexts = context.messages.map((message) =>
					typeof message.content === 'string'
						? message.content
						: message.content
								.map((block) => ('text' in block ? block.text : `[${block.type}]`))
								.join('\n'),
				);
				return fauxAssistantMessage('Proceeding.');
			},
		]);

		const runOrder: string[] = [];
		function assistant() {
			const delivery = useDelivery();
			useEffect(({ append }) => {
				runOrder.push('first');
				append({
					type: 'intake',
					body: 'Issue loaded; triage warranted.',
					attributes: { issue: '42' },
				});
			}, [delivery]);
			useEffect((ctx) => {
				// The invocation harness materializes lazily on first access.
				if (!ctx.harness) throw new Error('harness did not materialize');
				runOrder.push('second');
			}, [delivery]);
			return 'Triage agent.';
		}

		const coordinator = makeCoordinator(provider, stores, assistant);
		await dispatchAndSettle(coordinator, 'Triage issue #42.');
		await coordinator.shutdown();

		// Declaration order, and the signal arrived before the first response —
		// after the delivered input in the model's context.
		expect(runOrder).toEqual(['first', 'second']);
		const texts = turnOneTexts ?? [];
		expect(texts.at(-1)).toContain('<signal type="intake" issue="42">');
		expect(texts.join('\n')).toContain('Triage issue #42.');

		// Durable topology matches what the model saw: input → signal → assistant.
		const records = readDurableRecords(dbPath);
		const reduced = reduceConversationRecords(createReducedInstanceState(), records);
		const conversation = [...reduced.conversations.values()][0];
		if (!conversation) throw new Error('no conversation');
		const kinds = getActiveConversationPath(conversation).map((entry) =>
			entry.type === 'message' ? entry.message.role : entry.type,
		);
		expect(kinds).toEqual(['user', 'signal', 'assistant']);
		// The memo records exist, one per effect index.
		const effectRuns = records.filter((record) => record.type === 'effect_run');
		expect(effectRuns.map((record) => record.index)).toEqual([0, 1]);
	});

	it('effect signals flush durably mid-effect — progress is visible before the effect completes', async () => {
		const dbPath = createTempDbPath();
		const stores = await connectSqlite(dbPath);
		const provider = createFauxProvider();
		provider.setResponses([fauxAssistantMessage('Done.')]);

		let visibleMidEffect = false;
		function assistant() {
			useEffect(async ({ append }) => {
				append({ type: 'progress', body: 'Loading the issue…' });
				// Poll the durable stream from INSIDE the still-running effect: the
				// signal must land (and stream to clients) without waiting for the
				// effect to complete.
				for (let attempt = 0; attempt < 100 && !visibleMidEffect; attempt++) {
					visibleMidEffect = readDurableRecords(dbPath).some(
						(record) => record.type === 'signal' && record.signalType === 'progress',
					);
					if (!visibleMidEffect) await new Promise((resolve) => setTimeout(resolve, 20));
				}
			}, []);
			return 'Agent.';
		}

		const coordinator = makeCoordinator(provider, stores, assistant);
		await dispatchAndSettle(coordinator, 'Go.');
		await coordinator.shutdown();

		expect(visibleMidEffect).toBe(true);
	});

	it('deps are a durable memo: [] runs once per instance, [delivery] once per distinct message', async () => {
		const dbPath = createTempDbPath();
		const stores = await connectSqlite(dbPath);
		const provider = createFauxProvider();
		provider.setResponses([
			fauxAssistantMessage('One.'),
			fauxAssistantMessage('Two.'),
			fauxAssistantMessage('Three.'),
		]);

		const runs: string[] = [];
		function assistant() {
			const delivery = useDelivery();
			useEffect(() => {
				runs.push('startup');
			}, []);
			useEffect(() => {
				runs.push(`message:${delivery.kind === 'user' ? delivery.body : ''}`);
			}, [delivery]);
			return 'Agent.';
		}

		const coordinator = makeCoordinator(provider, stores, assistant);
		await dispatchAndSettle(coordinator, 'First message.');
		await dispatchAndSettle(coordinator, 'Second message.');
		// A byte-identical re-delivery: the memo skips the [delivery] effect —
		// same fingerprint, work already done. (Include a distinguishing dep if
		// an effect must run on every delivery regardless.)
		await dispatchAndSettle(coordinator, 'Second message.');
		await coordinator.shutdown();

		expect(runs).toEqual([
			'startup',
			'message:First message.',
			'message:Second message.',
		]);
	});

	it('state deps re-run the effect at the next boundary after the value moves', async () => {
		const dbPath = createTempDbPath();
		const stores = await connectSqlite(dbPath);
		const provider = createFauxProvider();
		provider.setResponses([
			fauxAssistantMessage(fauxToolCall('advance_phase', {}, { id: 'tool-adv-1' }), {
				stopReason: 'toolUse',
			}),
			fauxAssistantMessage('Advanced.'),
			fauxAssistantMessage('Second run.'),
		]);

		const phasesSeen: string[] = [];
		function assistant() {
			const [phase, setPhase] = useState<string>('phase', 'intake');
			useTool({
				name: 'advance_phase',
				description: 'Move the machine to the next phase.',
				run: () => {
					setPhase('reproduce');
					return 'ok';
				},
			});
			useEffect(() => {
				phasesSeen.push(phase);
			}, [phase]);
			return 'Machine agent.';
		}

		const coordinator = makeCoordinator(provider, stores, assistant);
		await dispatchAndSettle(coordinator, 'Start.');
		await dispatchAndSettle(coordinator, 'Continue.');
		await coordinator.shutdown();

		// Ran at submission 1 (phase intake), then again at submission 2 because
		// the durable value moved — with the new value in scope.
		expect(phasesSeen).toEqual(['intake', 'reproduce']);
	});

	it('a throwing effect fails the submission before the model runs', async () => {
		const provider = createFauxProvider();
		provider.setResponses([fauxAssistantMessage('Never reached.')]);

		let modelCalled = false;
		provider.setResponses([
			() => {
				modelCalled = true;
				return fauxAssistantMessage('Never reached.');
			},
		]);

		function assistant() {
			useEffect(() => {
				throw new Error('intake exploded');
			}, []);
			return 'Agent.';
		}
		const agent = defineAgent(assistant, {
			model: `${provider.getModel().provider}/${provider.getModel().id}`,
		});

		const input: AgentSubmissionInput = {
			kind: 'direct',
			submissionId: `direct:${crypto.randomUUID()}`,
			agent: 'assistant',
			id: 'instance-failfast',
			message: { kind: 'user', body: 'Go.' },
			acceptedAt: '2026-07-07T00:00:00.000Z',
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
		await expect(
			createAgentSubmissionSessionHandler(agent, input, (s) =>
				s.processSubmissionInput(input, {
					submissionAttempt: { submissionId: input.submissionId, attemptId: 'attempt-1' },
				}),
			)(ctx),
		).rejects.toThrow(/useEffect callback \(effect #0 in declaration order\) threw: intake exploded/);
		expect(modelCalled).toBe(false);
	});

	it('an idempotent re-entry of a completed submission adopts instead of re-running', async () => {
		const provider = createFauxProvider();
		provider.setResponses([fauxAssistantMessage('Done.'), fauxAssistantMessage('Never.')]);

		let effectRuns = 0;
		function assistant() {
			const [, setSeeded] = useState<boolean>('seeded', false);
			useEffect(() => {
				effectRuns += 1;
				setSeeded(true);
			}, []);
			return 'Agent.';
		}
		const agent = defineAgent(assistant, {
			model: `${provider.getModel().provider}/${provider.getModel().id}`,
		});

		const input: AgentSubmissionInput = {
			kind: 'direct',
			submissionId: `direct:${crypto.randomUUID()}`,
			agent: 'assistant',
			id: 'instance-adopt',
			message: { kind: 'user', body: 'Go.' },
			acceptedAt: '2026-07-07T00:00:00.000Z',
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
		const process = () =>
			createAgentSubmissionSessionHandler(agent, input, (s) =>
				s.processSubmissionInput(input, {
					submissionAttempt: { submissionId: input.submissionId, attemptId: 'attempt-1' },
				}),
			)(ctx);
		await process();
		await process();

		// A silent effect (state write only, no signals) ran exactly once; the
		// re-entry adopted its durable outcome.
		expect(effectRuns).toBe(1);
	});
});
