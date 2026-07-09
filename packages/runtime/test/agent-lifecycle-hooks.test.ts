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
import { useAgentFinish } from '../src/hooks/use-agent-finish.ts';
import { useAgentStart } from '../src/hooks/use-agent-start.ts';
import { useDelivery } from '../src/hooks/use-delivery.ts';
import { useDispatchMessage } from '../src/hooks/use-dispatch-message.ts';
import { usePersistentState } from '../src/hooks/use-persistent-state.ts';
import { useTool } from '../src/hooks/use-tool.ts';
import {
	configureFlueRuntime,
	createFlueContext,
	createNodeDispatchQueue,
	type DispatchInput,
} from '../src/internal.ts';
import { createNodeAgentCoordinator } from '../src/node/agent-coordinator.ts';
import { sqlite } from '../src/node/agent-execution-store.ts';
import {
	type AgentSubmissionInput,
	createAgentSubmissionSessionHandler,
} from '../src/runtime/agent-submissions.ts';
import { resetFlueRuntimeForTests } from '../src/runtime/flue-app.ts';
import type { CreateAgentContextFn } from '../src/runtime/handle-agent.ts';
import { createNoopSessionEnv } from './fixtures/session-env.ts';
import { agentRecord, nodeRuntime } from './helpers/runtime-config.ts';

const providers: FauxProviderRegistration[] = [];
const tempDirs: string[] = [];

afterEach(() => {
	resetFlueRuntimeForTests();
	for (const provider of providers.splice(0)) provider.unregister();
	for (const dir of tempDirs.splice(0)) {
		try {
			rmSync(dir, { recursive: true });
		} catch {}
	}
});

function createFauxProvider(): FauxProviderRegistration {
	const provider = registerFauxProvider({
		provider: `agent-lifecycle-test-${crypto.randomUUID()}`,
	});
	providers.push(provider);
	return provider;
}

function createTempDbPath(): string {
	const dir = mkdtempSync(join(tmpdir(), 'flue-agent-lifecycle-'));
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

function activePathKinds(records: ConversationRecord[]): string[] {
	const reduced = reduceConversationRecords(createReducedInstanceState(), records);
	const conversation = [...reduced.conversations.values()][0];
	if (!conversation) throw new Error('no conversation');
	return getActiveConversationPath(conversation).map((entry) =>
		entry.type === 'message' ? entry.message.role : entry.type,
	);
}

function makeCoordinator(
	provider: FauxProviderRegistration,
	stores: Awaited<ReturnType<typeof connectSqlite>>,
	assistant: () => string | undefined,
) {
	const coordinator = createNodeAgentCoordinator({
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
	// The ambient runtime `useDispatchMessage()` resolves dispatches through —
	// wired to this same coordinator, like the real Node target.
	configureFlueRuntime({
		...nodeRuntime(),
		agents: [agentRecord('assistant')],
		dispatchQueue: createNodeDispatchQueue(coordinator),
	});
	return coordinator;
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

/** Run one direct submission through the session handler, outside the coordinator. */
function makeDirectProcess(provider: FauxProviderRegistration, assistant: () => string) {
	const agent = defineAgent(assistant, {
		model: `${provider.getModel().provider}/${provider.getModel().id}`,
	});
	const input: AgentSubmissionInput = {
		kind: 'direct',
		submissionId: `direct:${crypto.randomUUID()}`,
		agent: 'assistant',
		id: `instance-${crypto.randomUUID()}`,
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
	return () =>
		createAgentSubmissionSessionHandler(agent, input, (s) =>
			s.processSubmissionInput(input, {
				submissionAttempt: { submissionId: input.submissionId, attemptId: 'attempt-1' },
			}),
		)(ctx);
}

const CONFIG = { model: 'faux/agent-lifecycle' };

describe('useAgentStart()', () => {
	it('requires a callback', () => {
		expect(() =>
			renderAgentFunctionWithStructure(() => {
				(useAgentStart as unknown as (run: unknown) => void)('nope');
				return 'Base.';
			}, CONFIG),
		).toThrow(/takes a callback as its only argument/);
	});

	it('is unavailable in subagent renders', () => {
		expect(() =>
			renderWithFrame(
				() => {
					useAgentStart(() => {});
				},
				undefined,
				'subagent',
			),
		).toThrow(/not available in a subagent render/);
	});

	it('declaration counts join the structural invariance fingerprint', () => {
		const one = renderAgentFunctionWithStructure(() => {
			useAgentStart(() => {});
			return 'Base.';
		}, CONFIG).structure;
		const two = renderAgentFunctionWithStructure(() => {
			useAgentStart(() => {});
			useAgentStart(() => {});
			return 'Base.';
		}, CONFIG).structure;
		expect(() => assertRenderStructureInvariance(one, two)).toThrow(
			/useAgentStart count changed \(1 → 2\)/,
		);

		const finishOne = renderAgentFunctionWithStructure(() => {
			useAgentFinish(() => {});
			return 'Base.';
		}, CONFIG).structure;
		const finishTwo = renderAgentFunctionWithStructure(() => {
			useAgentFinish(() => {});
			useAgentFinish(() => {});
			return 'Base.';
		}, CONFIG).structure;
		expect(() => assertRenderStructureInvariance(finishOne, finishTwo)).toThrow(
			/useAgentFinish count changed \(1 → 2\)/,
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
			const dispatch = useDispatchMessage();
			// The DURABLE guard from the docs: the intake dispatch is itself a
			// delivery that re-fires these hooks, and the joined delivery's
			// hooks run against a fresh render (the join boundary re-renders),
			// so the guard reliably observes the write — no duplicate intake.
			const [intakeDone, setIntakeDone] = usePersistentState('intake_done', false);
			useAgentStart(async () => {
				runOrder.push(intakeDone ? 'first:guarded' : 'first');
				if (intakeDone) return;
				setIntakeDone(true);
				await dispatch({
					kind: 'signal',
					type: 'intake',
					body: 'Issue loaded; triage warranted.',
					attributes: { issue: '42' },
				});
			});
			useAgentStart((ctx) => {
				// The invocation harness materializes lazily on first access.
				if (!ctx.harness) throw new Error('harness did not materialize');
				runOrder.push('second');
			});
			return 'Triage agent.';
		}

		const coordinator = makeCoordinator(provider, stores, assistant);
		await dispatchAndSettle(coordinator, 'Triage issue #42.');
		await coordinator.shutdown();

		// Declaration order, twice: once for the waking delivery, once for the
		// intake signal that joined the response — and the joined run saw the
		// guard's durable write, so exactly ONE intake signal exists.
		expect(runOrder).toEqual(['first', 'second', 'first:guarded', 'second']);
		const texts = turnOneTexts ?? [];
		expect(texts.at(-1)).toContain('<signal type="intake" issue="42">');
		expect(texts.join('\n')).toContain('Triage issue #42.');

		// Durable topology matches what the model saw: input → signal → assistant.
		const records = readDurableRecords(dbPath);
		expect(activePathKinds(records)).toEqual(['user', 'signal', 'assistant']);
		// Adoption records per delivery: one per declaration index for the
		// waking delivery AND for the joined intake delivery.
		const startRuns = records.filter((record) => record.type === 'agent_start_run');
		expect(startRuns.map((record) => record.index)).toEqual([0, 1, 0, 1]);
		expect(new Set(startRuns.map((record) => record.submissionId)).size).toBe(2);
	});

	it('useDelivery is a cursor: a joined delivery start hook reads THAT message', async () => {
		const dbPath = createTempDbPath();
		const stores = await connectSqlite(dbPath);
		const provider = createFauxProvider();
		provider.setResponses([
			fauxAssistantMessage(fauxToolCall('trigger_dispatches', {}, { id: 'tool-cur-1' }), {
				stopReason: 'toolUse',
			}),
			fauxAssistantMessage('All handled.'),
		]);

		const hookSaw: string[] = [];
		function assistant() {
			const delivery = useDelivery();
			const dispatch = useDispatchMessage();
			useAgentStart(() => {
				hookSaw.push(delivery.kind === 'signal' ? `signal:${delivery.type}` : `user:${delivery.body}`);
			});
			useTool({
				name: 'trigger_dispatches',
				description: 'Dispatch two follow-up signals to this same instance mid-run.',
				run: async () => {
					await dispatch({ kind: 'signal', type: 'first', body: 'One.' });
					await dispatch({ kind: 'signal', type: 'second', body: 'Two.' });
					return 'dispatched';
				},
			});
			return 'Agent.';
		}

		const coordinator = makeCoordinator(provider, stores, assistant);
		await dispatchAndSettle(coordinator, 'Go.');
		await coordinator.shutdown();

		// The join boundary re-renders with the cursor advanced, so each
		// delivery's hook run closes over ITS message — the waking user
		// message, then each joined signal, in the order the model read them.
		expect(hookSaw).toEqual(['user:Go.', 'signal:first', 'signal:second']);
	});

	it('a finish append advances the cursor for the continuation render', async () => {
		const dbPath = createTempDbPath();
		const stores = await connectSqlite(dbPath);
		const provider = createFauxProvider();
		provider.setResponses([
			fauxAssistantMessage('Text only.'),
			fauxAssistantMessage('Handled the reminder.'),
		]);

		const rendersSaw: string[] = [];
		let nudged = false;
		function assistant() {
			const delivery = useDelivery();
			rendersSaw.push(delivery.kind === 'signal' ? `signal:${delivery.type}` : `user:${delivery.body}`);
			useAgentFinish(({ append }) => {
				if (nudged) return;
				nudged = true;
				append({ kind: 'signal', type: 'reminder', body: 'Keep going.' });
			});
			return 'Agent.';
		}

		const coordinator = makeCoordinator(provider, stores, assistant);
		await dispatchAndSettle(coordinator, 'Go.');
		await coordinator.shutdown();

		// The appended reminder is the message in front of the model on the
		// continuation turn — its render's cursor says so.
		expect(rendersSaw.at(0)).toBe('user:Go.');
		expect(rendersSaw.at(-1)).toBe('signal:reminder');
	});

	it('ctx.append writes a signal ahead of turn one without registering a delivery', async () => {
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

		let captured: ((message: { kind: 'signal'; type: string; body: string }) => void) | undefined;
		function assistant() {
			useAgentStart(({ append }) => {
				captured = append;
				append({
					kind: 'signal',
					type: 'note',
					body: 'Digest saved at triage/gh-42/issue.md.',
				});
			});
			return 'Agent.';
		}

		const coordinator = makeCoordinator(provider, stores, assistant);
		await dispatchAndSettle(coordinator, 'Go.');
		await coordinator.shutdown();

		// The model read the signal on its first turn.
		expect((turnOneTexts ?? []).join('\n')).toContain('Digest saved at triage/gh-42/issue.md.');

		// An append is NOT a delivery: no dispatchId on the record, no extra
		// useAgentStart run — one adoption record for the one real delivery.
		const records = readDurableRecords(dbPath);
		expect(activePathKinds(records)).toEqual(['user', 'signal', 'assistant']);
		const signalRecord = records.find((record) => record.type === 'signal');
		expect(signalRecord).toMatchObject({ signalType: 'note' });
		expect(
			signalRecord && 'dispatchId' in signalRecord ? signalRecord.dispatchId : undefined,
		).toBeUndefined();
		const startRuns = records.filter((record) => record.type === 'agent_start_run');
		expect(startRuns.map((record) => record.index)).toEqual([0]);

		// The writer is scoped to the callback window.
		expect(() => captured?.({ kind: 'signal', type: 'note', body: 'Too late.' })).toThrow(
			/after its useAgentStart callback settled/,
		);
	});

	it('runs on every delivered message — including byte-identical re-deliveries', async () => {
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
			useAgentStart(() => {
				runs.push(`message:${delivery.kind === 'user' ? delivery.body : ''}`);
			});
			return 'Agent.';
		}

		const coordinator = makeCoordinator(provider, stores, assistant);
		await dispatchAndSettle(coordinator, 'First message.');
		await dispatchAndSettle(coordinator, 'Second message.');
		// Every delivery is a fresh start — no deps memo, no fingerprint. Work
		// that should happen once per instance guards with durable state.
		await dispatchAndSettle(coordinator, 'Second message.');
		await coordinator.shutdown();

		expect(runs).toEqual([
			'message:First message.',
			'message:Second message.',
			'message:Second message.',
		]);
	});

	it('a throwing callback fails the submission before the model runs', async () => {
		const provider = createFauxProvider();
		let modelCalled = false;
		provider.setResponses([
			() => {
				modelCalled = true;
				return fauxAssistantMessage('Never reached.');
			},
		]);

		function assistant() {
			useAgentStart(() => {
				throw new Error('intake exploded');
			});
			return 'Agent.';
		}

		await expect(makeDirectProcess(provider, assistant)()).rejects.toThrow(
			/useAgentStart callback \(hook #0 in declaration order\) threw: intake exploded/,
		);
		expect(modelCalled).toBe(false);
	});

	it('an idempotent re-entry of a completed submission adopts instead of re-running', async () => {
		const provider = createFauxProvider();
		provider.setResponses([fauxAssistantMessage('Done.'), fauxAssistantMessage('Never.')]);

		let startRuns = 0;
		function assistant() {
			const [, setSeeded] = usePersistentState<boolean>('seeded', false);
			useAgentStart(() => {
				startRuns += 1;
				setSeeded(true);
			});
			return 'Agent.';
		}

		const process = makeDirectProcess(provider, assistant);
		await process();
		await process();

		// A silent callback (state write only, no signals) ran exactly once; the
		// re-entry adopted its durable outcome.
		expect(startRuns).toBe(1);
	});
});

describe('useAgentFinish()', () => {
	it('requires a callback and is unavailable in subagent renders', () => {
		expect(() =>
			renderAgentFunctionWithStructure(() => {
				(useAgentFinish as unknown as (run: unknown) => void)('nope');
				return 'Base.';
			}, CONFIG),
		).toThrow(/takes a callback as its only argument/);
		expect(() =>
			renderWithFrame(
				() => {
					useAgentFinish(() => {});
				},
				undefined,
				'subagent',
			),
		).toThrow(/not available in a subagent render/);
	});

	it('appending continues the response in the same submission; a clean cycle settles it', async () => {
		const dbPath = createTempDbPath();
		const stores = await connectSqlite(dbPath);
		const provider = createFauxProvider();
		provider.setResponses([
			// Turn 1: the model "forgets" the delivery tool.
			fauxAssistantMessage('Here is my answer, in text only.'),
			// Continuation turn after the reminder signal: it calls the tool.
			fauxAssistantMessage(fauxToolCall('post_message', {}, { id: 'tool-post-1' }), {
				stopReason: 'toolUse',
			}),
			fauxAssistantMessage('Posted.'),
		]);

		const cyclesSeen: Array<Array<{ tool: string; isError: boolean }>> = [];
		function assistant() {
			useTool({
				name: 'post_message',
				description: 'Deliver the answer to the channel.',
				run: () => 'posted',
			});
			useAgentFinish(({ response, append }) => {
				cyclesSeen.push(response.toolCalls.map((call) => ({ ...call })));
				const posted = response.toolCalls.some(
					(call) => call.tool === 'post_message' && !call.isError,
				);
				if (posted) return;
				append({
					kind: 'signal',
					type: 'reminder',
					body: 'You ended without calling post_message — call it now.',
				});
			});
			return 'Deliver answers with post_message.';
		}

		const coordinator = makeCoordinator(provider, stores, assistant);
		await dispatchAndSettle(coordinator, 'Answer me.');
		await coordinator.shutdown();

		// Cycle 1 saw no tool calls and nudged; cycle 2 saw the successful call
		// (aggregated across turns) and settled.
		expect(cyclesSeen).toEqual([[], [{ tool: 'post_message', isError: false }]]);

		// One response: reminder signal and continuation turns chain onto the
		// same conversation path, no second submission.
		const records = readDurableRecords(dbPath);
		expect(activePathKinds(records)).toEqual([
			'user',
			'assistant',
			'signal',
			'assistant',
			'toolResult',
			'assistant',
		]);
		const cycles = records.filter((record) => record.type === 'agent_finish_cycle');
		expect(cycles.map((record) => record.cycle)).toEqual([1]);
	});

	it('runs only at the would-stop seam and sees tool calls from every turn', async () => {
		const dbPath = createTempDbPath();
		const stores = await connectSqlite(dbPath);
		const provider = createFauxProvider();
		provider.setResponses([
			fauxAssistantMessage(fauxToolCall('lookup', {}, { id: 'tool-lookup-1' }), {
				stopReason: 'toolUse',
			}),
			fauxAssistantMessage('All done.'),
		]);

		const cyclesSeen: Array<Array<{ tool: string; isError: boolean }>> = [];
		function assistant() {
			useTool({
				name: 'lookup',
				description: 'Look something up.',
				run: () => 'found',
			});
			useAgentFinish(({ response }) => {
				cyclesSeen.push(response.toolCalls.map((call) => ({ ...call })));
			});
			return 'Agent.';
		}

		const coordinator = makeCoordinator(provider, stores, assistant);
		await dispatchAndSettle(coordinator, 'Go.');
		await coordinator.shutdown();

		// Exactly one evaluation — never after the intermediate tool turn — and
		// it aggregates the whole response's calls.
		expect(cyclesSeen).toEqual([[{ tool: 'lookup', isError: false }]]);
		const records = readDurableRecords(dbPath);
		expect(records.filter((record) => record.type === 'agent_finish_cycle')).toEqual([]);
	});

	it('a throwing callback fails the submission', async () => {
		const provider = createFauxProvider();
		provider.setResponses([fauxAssistantMessage('Done.')]);

		function assistant() {
			useAgentFinish(() => {
				throw new Error('finish check exploded');
			});
			return 'Agent.';
		}

		await expect(makeDirectProcess(provider, assistant)()).rejects.toThrow(
			/useAgentFinish callback \(hook #0 in declaration order\) threw: finish check exploded/,
		);
	});

	it('a hook that always appends fails loudly at the runaway ceiling', async () => {
		const provider = createFauxProvider();
		provider.setResponses(
			Array.from({ length: 40 }, () => fauxAssistantMessage('Still just text.')),
		);

		function assistant() {
			useAgentFinish(({ append }) => {
				append({ kind: 'signal', type: 'reminder', body: 'Again.' });
			});
			return 'Agent.';
		}

		await expect(makeDirectProcess(provider, assistant)()).rejects.toThrow(
			/useAgentFinish appended a continuation signal after 32 continued cycles/,
		);
	});

	it('an idempotent re-entry of a settled continuation neither re-runs the cycle nor double-appends', async () => {
		const provider = createFauxProvider();
		provider.setResponses([
			fauxAssistantMessage('Text only.'),
			fauxAssistantMessage(fauxToolCall('post_message', {}, { id: 'tool-post-2' }), {
				stopReason: 'toolUse',
			}),
			fauxAssistantMessage('Posted.'),
			fauxAssistantMessage('Never reached.'),
		]);

		let appends = 0;
		function assistant() {
			useTool({
				name: 'post_message',
				description: 'Deliver the answer.',
				run: () => 'posted',
			});
			useAgentFinish(({ response, append }) => {
				const posted = response.toolCalls.some(
					(call) => call.tool === 'post_message' && !call.isError,
				);
				if (posted) return;
				appends += 1;
				append({ kind: 'signal', type: 'reminder', body: 'Call post_message now.' });
			});
			return 'Agent.';
		}

		const process = makeDirectProcess(provider, assistant);
		await process();
		await process();

		// The first pass nudged once; the re-entry re-evaluated the (satisfied)
		// hook against durable tool records and settled without appending.
		expect(appends).toBe(1);
	});
});

describe('useAgentFinish ctx.append', () => {
	it('rejects kind:"user" with a pointer to dispatch, and validates the signal shape', async () => {
		const provider = createFauxProvider();
		provider.setResponses([fauxAssistantMessage('Done.')]);

		const failures: string[] = [];
		function assistant() {
			useAgentFinish(({ append }) => {
				try {
					append({ kind: 'user', body: 'New input.' } as never);
				} catch (error) {
					failures.push(error instanceof Error ? error.message : String(error));
				}
				try {
					append({ kind: 'signal', type: '', body: 'Empty type.' });
				} catch (error) {
					failures.push(error instanceof Error ? error.message : String(error));
				}
			});
			return 'Agent.';
		}

		await makeDirectProcess(provider, assistant)();

		expect(failures).toHaveLength(2);
		expect(failures[0]).toMatch(/real new input.*useDispatchMessage/);
		expect(failures[1]).toMatch(/"type" must not be empty/);
	});

	it('is scoped to the callback window — a captured reference throws afterwards', async () => {
		const provider = createFauxProvider();
		provider.setResponses([fauxAssistantMessage('Done.')]);

		let captured: ((message: { kind: 'signal'; type: string; body: string }) => void) | undefined;
		function assistant() {
			useAgentFinish(({ append }) => {
				captured = append;
			});
			return 'Agent.';
		}

		await makeDirectProcess(provider, assistant)();

		expect(captured).toBeDefined();
		expect(() => captured?.({ kind: 'signal', type: 'note', body: 'Too late.' })).toThrow(
			/after its useAgentFinish callback settled/,
		);
	});
});
