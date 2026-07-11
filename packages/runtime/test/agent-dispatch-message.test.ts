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
import type { ConversationRecord } from '../src/conversation-records.ts';
import {
	createReducedInstanceState,
	getActiveConversationPath,
	reduceConversationRecords,
} from '../src/conversation-reducer.ts';
import { renderWithFrame } from '../src/hooks/frame.ts';
import { renderAgentFunctionWithStructure } from '../src/hooks/render.ts';
import { useAgentFinish } from '../src/hooks/use-agent-finish.ts';
import { useAgentStart } from '../src/hooks/use-agent-start.ts';
import { useDispatchMessage } from '../src/hooks/use-dispatch-message.ts';
import { useModel } from '../src/hooks/use-model.ts';
import { useTool } from '../src/hooks/use-tool.ts';
import {
	configureFlueRuntime,
	createFlueContext,
	createNodeAgentCoordinator,
	createNodeDispatchQueue,
	type DispatchInput,
} from '../src/internal.ts';
import { sqlite } from '../src/node/agent-execution-store.ts';
import { resetFlueRuntimeForTests } from '../src/runtime/flue-app.ts';
import type { CreateAgentContextFn } from '../src/runtime/handle-agent.ts';
import type { DeliveredMessage, DeliveredMessageInput, DispatchReceipt } from '../src/types.ts';
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
		provider: `agent-dispatch-message-test-${crypto.randomUUID()}`,
	});
	providers.push(provider);
	return provider;
}

function createTempDbPath(): string {
	const dir = mkdtempSync(join(tmpdir(), 'flue-agent-dispatch-message-'));
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

/**
 * The active conversation path, collapsed to one label per entry — `role`
 * for ordinary messages, `signal:<type>` for signals, else the entry type.
 * Mirrors the shape used across the runtime test suite to assert conversation
 * topology without pinning every envelope field.
 */
function activePathKinds(records: ConversationRecord[]): string[] {
	const reduced = reduceConversationRecords(createReducedInstanceState(), records);
	const conversation = [...reduced.conversations.values()][0];
	if (!conversation) throw new Error('no conversation');
	return getActiveConversationPath(conversation).map((entry) =>
		entry.type === 'message'
			? entry.message.role === 'signal'
				? `signal:${entry.message.type}`
				: entry.message.role
			: entry.type,
	);
}

/**
 * Sets up a coordinator running a single "assistant" agent, plus a Flue
 * runtime configured so `useDispatchMessage()` resolves real dispatches
 * through that same coordinator — the ambient runtime the hook requires.
 */
function setupDispatchHarness(
	provider: FauxProviderRegistration,
	assistant: () => string | undefined,
) {
	const dbPath = createTempDbPath();
	const executionStorePromise = connectSqlite(dbPath);
	return executionStorePromise.then((stores) => {
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
			conversationStreamStore: stores.conversationStreamStore,
			attachmentStore: stores.attachmentStore,
		});
		configureFlueRuntime({
			...nodeRuntime(),
			agents: [agentRecord('assistant')],
			dispatchQueue: createNodeDispatchQueue(coordinator),
		});
		return { dbPath, coordinator };
	});
}

async function admitAndSettle(
	coordinator: ReturnType<typeof createNodeAgentCoordinator>,
	message: DeliveredMessage,
	id = 'instance-1',
): Promise<void> {
	await coordinator.admitDispatch({
		dispatchId: `dispatch-${crypto.randomUUID()}`,
		agent: 'assistant',
		id,
		message,
		acceptedAt: new Date().toISOString(),
	} satisfies DispatchInput);
	await coordinator.waitForIdle();
}

const MODEL = 'faux/agent-dispatch-message';

describe('useDispatchMessage()', () => {
	it('a tool-triggered mid-run dispatch joins the live response at the next turn boundary', async () => {
		const provider = createFauxProvider();
		let turnTwoTexts: string[] | undefined;
		provider.setResponses([
			fauxAssistantMessage(fauxToolCall('trigger_dispatch', {}, { id: 'tool-td-1' }), {
				stopReason: 'toolUse',
			}),
			(context) => {
				turnTwoTexts = context.messages.map((message) =>
					typeof message.content === 'string'
						? message.content
						: message.content
								.map((block) => ('text' in block ? block.text : `[${block.type}]`))
								.join('\n'),
				);
				return fauxAssistantMessage('Turn two done.');
			},
		]);

		const receipts: DispatchReceipt[] = [];
		function assistant() {
			const dispatchMessage = useDispatchMessage();
			useTool({
				name: 'trigger_dispatch',
				description: 'Dispatch a follow-up signal to this same instance mid-run.',
				run: async () => {
					const receipt = await dispatchMessage({
						kind: 'signal',
						type: 'note',
						body: 'Follow-up signal.',
						attributes: { source: 'tool' },
					});
					receipts.push(receipt);
					return 'dispatched';
				},
			});
			return 'Agent.';
		}

		const { dbPath, coordinator } = await setupDispatchHarness(provider, assistant);
		await admitAndSettle(coordinator, { kind: 'user', body: 'Go.' });
		await coordinator.shutdown();

		expect(receipts).toHaveLength(1);
		expect(receipts[0]?.dispatchId).toEqual(expect.any(String));

		// Dispatch-while-busy: the queued delivery joined the LIVE response at
		// the turn boundary right after the tool batch — the model read it on
		// its very next turn, in the same response.
		expect(turnTwoTexts).toBeDefined();
		const joined = (turnTwoTexts ?? []).join('\n---\n');
		expect(joined).toContain('<signal type="note" source="tool">');
		expect(joined).toContain('Follow-up signal.');

		// Still a real delivery, not an append: the signal record carries its
		// dispatchId — but it lands INSIDE the live response instead of waking
		// a serialized follow-up submission.
		const records = readDurableRecords(dbPath);
		const signalRecord = records.find((record) => record.type === 'signal');
		expect(signalRecord).toMatchObject({
			signalType: 'note',
			content: 'Follow-up signal.',
			attributes: { source: 'tool' },
		});
		expect(signalRecord?.dispatchId).toEqual(expect.any(String));

		expect(activePathKinds(records)).toEqual([
			'user',
			'assistant',
			'toolResult',
			'signal:note',
			'assistant',
		]);

		// The joined delivery settled WITH its host, sharing the outcome.
		const db = new DatabaseSync(dbPath);
		const joinedRow = db
			.prepare(
				'SELECT status, joined_into, error FROM flue_agent_submissions WHERE submission_id = ?',
			)
			.get(receipts[0]?.dispatchId ?? '') as Record<string, unknown>;
		db.close();
		expect(joinedRow).toMatchObject({
			status: 'settled',
			joined_into: expect.any(String),
			error: null,
		});
	});

	it('multiple mid-run dispatches coalesce: one useAgentStart per delivery, one useAgentFinish', async () => {
		const provider = createFauxProvider();
		provider.setResponses([
			fauxAssistantMessage(fauxToolCall('trigger_dispatches', {}, { id: 'tool-td-2' }), {
				stopReason: 'toolUse',
			}),
			fauxAssistantMessage('All handled.'),
		]);

		let startRuns = 0;
		let finishRuns = 0;
		function assistant() {
			const dispatchMessage = useDispatchMessage();
			useAgentStart(() => {
				startRuns += 1;
			});
			useAgentFinish(() => {
				finishRuns += 1;
			});
			useTool({
				name: 'trigger_dispatches',
				description: 'Dispatch two follow-up signals to this same instance mid-run.',
				run: async () => {
					await dispatchMessage({ kind: 'signal', type: 'first', body: 'One.' });
					await dispatchMessage({ kind: 'signal', type: 'second', body: 'Two.' });
					return 'dispatched';
				},
			});
			return 'Agent.';
		}

		const { dbPath, coordinator } = await setupDispatchHarness(provider, assistant);
		await admitAndSettle(coordinator, { kind: 'user', body: 'Go.' });
		await coordinator.shutdown();

		// Three deliveries collected into ONE response: a start-hook run per
		// message (host + two joined), and a single finish evaluation once the
		// agent was finally done with all of them.
		expect(startRuns).toBe(3);
		expect(finishRuns).toBe(1);

		const records = readDurableRecords(dbPath);
		expect(activePathKinds(records)).toEqual([
			'user',
			'assistant',
			'toolResult',
			'signal:first',
			'signal:second',
			'assistant',
		]);
	});

	it('a direct (HTTP) prompt arriving mid-response joins it and still settles its waiter record', async () => {
		const provider = createFauxProvider();
		provider.setResponses([
			fauxAssistantMessage(fauxToolCall('trigger_direct', {}, { id: 'tool-hd-1' }), {
				stopReason: 'toolUse',
			}),
			fauxAssistantMessage('Handled both.'),
		]);

		let directSubmissionId: string | undefined;
		let admitDirect: ((message: DeliveredMessage) => Promise<{ submissionId: string }>) | undefined;
		function assistant() {
			useTool({
				name: 'trigger_direct',
				description: 'Simulate an HTTP prompt landing while this response is running.',
				run: async () => {
					const receipt = await admitDirect?.({ kind: 'user', body: 'And also this.' });
					directSubmissionId = receipt?.submissionId;
					return 'admitted';
				},
			});
			return 'Agent.';
		}

		const { dbPath, coordinator } = await setupDispatchHarness(provider, assistant);
		const admission = coordinator.createAdmission('assistant', 'instance-1');
		admitDirect = (message) => admission(message);
		await admitAndSettle(coordinator, { kind: 'user', body: 'Go.' });
		await coordinator.shutdown();

		expect(directSubmissionId).toEqual(expect.any(String));

		// HTTP and dispatch behave alike: the direct prompt joined the live
		// response as a real user message at the turn boundary.
		const records = readDurableRecords(dbPath);
		expect(activePathKinds(records)).toEqual([
			'user',
			'assistant',
			'toolResult',
			'user',
			'assistant',
		]);

		// The waiter contract survives the join: the joined direct delivery
		// still settled through the outbox with a durable settled record
		// carrying the shared outcome.
		const settledRecord = records.find(
			(record) =>
				record.type === 'submission_settled' && record.submissionId === directSubmissionId,
		);
		expect(settledRecord).toMatchObject({ outcome: 'completed' });

		const db = new DatabaseSync(dbPath);
		const joinedRow = db
			.prepare(
				'SELECT status, joined_into, error FROM flue_agent_submissions WHERE submission_id = ?',
			)
			.get(directSubmissionId ?? '') as Record<string, unknown>;
		db.close();
		expect(joinedRow).toMatchObject({
			status: 'settled',
			joined_into: expect.any(String),
			error: null,
		});
	});

	it('a dispatch from useAgentFinish joins the live response and re-fires the hook at the new true end', async () => {
		const provider = createFauxProvider();
		provider.setResponses([
			fauxAssistantMessage('First answer.'),
			fauxAssistantMessage('Handled the reminder.'),
		]);

		const finishCycles: number[] = [];
		let nudged = false;
		function assistant() {
			const dispatchMessage = useDispatchMessage();
			useAgentFinish(async ({ response }) => {
				finishCycles.push(response.toolCalls.length);
				if (nudged) return;
				nudged = true;
				await dispatchMessage({ kind: 'signal', type: 'nudge', body: 'Keep going.' });
			});
			return 'Agent.';
		}

		const { dbPath, coordinator } = await setupDispatchHarness(provider, assistant);
		await admitAndSettle(coordinator, { kind: 'user', body: 'Go.' });
		await coordinator.shutdown();

		// The self-dispatch joined the SAME response (no second submission ran
		// its own start-to-finish), and useAgentFinish fired again once the
		// joined delivery was dealt with — the agent is only "finally done"
		// when the queue is empty at the would-stop.
		expect(finishCycles).toHaveLength(2);

		const records = readDurableRecords(dbPath);
		const signalRecord = records.find((record) => record.type === 'signal');
		expect(signalRecord).toMatchObject({ signalType: 'nudge', content: 'Keep going.' });
		expect(signalRecord?.dispatchId).toEqual(expect.any(String));
		expect(activePathKinds(records)).toEqual([
			'user',
			'assistant',
			'signal:nudge',
			'assistant',
		]);
	});

	it('a dispatch captured mid-run but called after the agent goes idle wakes a new submission', async () => {
		const provider = createFauxProvider();
		provider.setResponses([
			fauxAssistantMessage(fauxToolCall('capture_dispatch', {}, { id: 'tool-cd-1' }), {
				stopReason: 'toolUse',
			}),
			fauxAssistantMessage('Turn one done.'),
			fauxAssistantMessage('Woke up.'),
		]);

		let captured: ((message: DeliveredMessage) => Promise<DispatchReceipt>) | undefined;
		function assistant() {
			const dispatchMessage = useDispatchMessage();
			useTool({
				name: 'capture_dispatch',
				description: 'Capture the dispatcher for later, out-of-band use.',
				run: () => {
					captured = dispatchMessage;
					return 'captured';
				},
			});
			return 'Agent.';
		}

		const { dbPath, coordinator } = await setupDispatchHarness(provider, assistant);
		await admitAndSettle(coordinator, { kind: 'user', body: 'Go.' });

		expect(captured).toBeDefined();
		// The run has fully settled — this call behaves exactly like an
		// external sender's dispatch to an idle instance.
		const receipt = await captured?.({ kind: 'signal', type: 'wake', body: 'Waking up.' });
		expect(receipt?.dispatchId).toEqual(expect.any(String));
		await coordinator.waitForIdle();
		await coordinator.shutdown();

		const records = readDurableRecords(dbPath);
		const signalRecord = records.find((record) => record.type === 'signal');
		expect(signalRecord).toMatchObject({ signalType: 'wake', content: 'Waking up.' });
		expect(signalRecord?.dispatchId).toEqual(expect.any(String));

		expect(activePathKinds(records)).toEqual([
			'user',
			'assistant',
			'toolResult',
			'assistant',
			'signal:wake',
			'assistant',
		]);
	});

	it('a kind:"user" self-dispatch queues a real follow-up turn', async () => {
		const provider = createFauxProvider();
		provider.setResponses([
			fauxAssistantMessage(fauxToolCall('capture_dispatch', {}, { id: 'tool-cd-2' }), {
				stopReason: 'toolUse',
			}),
			fauxAssistantMessage('Turn one done.'),
			fauxAssistantMessage('Continued.'),
		]);

		let captured: ((message: DeliveredMessageInput) => Promise<DispatchReceipt>) | undefined;
		function assistant() {
			const dispatchMessage = useDispatchMessage();
			useTool({
				name: 'capture_dispatch',
				description: 'Capture the dispatcher for later, out-of-band use.',
				run: () => {
					captured = dispatchMessage;
					return 'captured';
				},
			});
			return 'Agent.';
		}

		const { dbPath, coordinator } = await setupDispatchHarness(provider, assistant);
		await admitAndSettle(coordinator, { kind: 'user', body: 'Go.' });

		expect(captured).toBeDefined();
		// The string shorthand works on the hook's dispatcher too.
		const receipt = await captured?.('Continue please.');
		expect(receipt?.dispatchId).toEqual(expect.any(String));
		await coordinator.waitForIdle();
		await coordinator.shutdown();

		// A `user` self-dispatch is a real follow-up turn — a second
		// `user_message` record, not a `signal`.
		const records = readDurableRecords(dbPath);
		expect(records.some((record) => record.type === 'signal')).toBe(false);
		const userMessages = records.filter((record) => record.type === 'user_message');
		expect(userMessages).toHaveLength(2);
		expect(userMessages[1]?.content).toEqual([{ type: 'text', text: 'Continue please.' }]);

		expect(activePathKinds(records)).toEqual([
			'user',
			'assistant',
			'toolResult',
			'assistant',
			'user',
			'assistant',
		]);
	});

	it('rejects a dispatch call made during render', async () => {
		let duringRenderPromise: Promise<DispatchReceipt> | undefined;
		renderAgentFunctionWithStructure(() => {
			useModel(MODEL);
			const dispatchMessage = useDispatchMessage();
			duringRenderPromise = dispatchMessage({ kind: 'signal', type: 'note', body: 'Rendered.' });
			// Attach a no-op catch so vitest's process-level unhandled-rejection
			// guard does not flag the rejection we are about to assert on.
			duringRenderPromise.catch(() => {});
			return 'Base.';
		});

		await expect(duringRenderPromise).rejects.toThrow(/called during render/);
	});

	it('is unavailable in subagent renders', () => {
		expect(() =>
			renderWithFrame(
				() => {
					useDispatchMessage();
				},
				undefined,
				'subagent',
			),
		).toThrow(/not available in a subagent render/);
	});

	it('throws on call when the render has no durable runtime behind it (bare render)', async () => {
		let dispatchMessage: ((message: DeliveredMessage) => Promise<DispatchReceipt>) | undefined;
		renderAgentFunctionWithStructure(() => {
			useModel(MODEL);
			dispatchMessage = useDispatchMessage();
			return 'Base.';
		});

		await expect(
			dispatchMessage?.({ kind: 'signal', type: 'note', body: 'Unbacked.' }),
		).rejects.toThrow(/no durable runtime behind this render/);
	});
});
