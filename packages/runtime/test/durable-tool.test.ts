// `durable: true` tools: `step.do` memoization into canonical
// `tool_step_settled` records, and the scoped recovery exception — an
// interrupted durable call re-executes with completed steps replaying from
// their memos, while ordinary calls keep the never-re-execute contract.
import { fork } from 'node:child_process';
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
import { defineAgent } from '../src/agent-definition.ts';
import { toolStepRecordId } from '../src/conversation-records.ts';
import { useModel } from '../src/hooks/use-model.ts';
import { useTool } from '../src/hooks/use-tool.ts';
import { createFlueContext, type DispatchInput } from '../src/internal.ts';
import { createNodeAgentCoordinator } from '../src/node/agent-coordinator.ts';
import { sqlite } from '../src/node/agent-execution-store.ts';
import type { CreateAgentContextFn } from '../src/runtime/handle-agent.ts';
import { agentStreamPath } from '../src/runtime/stream-offsets.ts';
import { defineTool, parseToolInput } from '../src/tool.ts';
import type { ToolStep } from '../src/tool-types.ts';
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
		provider: `durable-tool-test-${crypto.randomUUID()}`,
	});
	providers.push(provider);
	return provider;
}

function createTempDbPath(): string {
	const dir = mkdtempSync(join(tmpdir(), 'flue-durable-tool-'));
	tempDirs.push(dir);
	return join(dir, 'agent.db');
}

/** Pre-populate a durable store with the killed-mid-durable-tool-batch state
 *  (see fixtures/durable-boundary-child.mjs, mode 'durable-tool-repair'). */
async function killAtDurableToolBoundary(dbPath: string): Promise<void> {
	const child = fork(
		join(import.meta.dirname, 'fixtures', 'durable-boundary-child.mjs'),
		['durable-tool-repair', dbPath],
		{ stdio: ['ignore', 'ignore', 'inherit', 'ipc'] },
	);
	await new Promise<void>((resolve, reject) => {
		child.once('error', reject);
		child.once('exit', (code, signal) => {
			if (signal !== 'SIGKILL')
				reject(new Error(`Boundary child exited before kill (${code}, ${signal}).`));
		});
		child.once('message', (message) => {
			if (message !== 'ready') return;
			child.kill('SIGKILL');
			child.once('exit', () => resolve());
		});
	});
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

async function createCoordinatorWithAgent(
	dbPath: string,
	provider: FauxProviderRegistration,
	agentFn: () => string,
) {
	const adapter = sqlite(dbPath);
	await adapter.migrate?.();
	const { executionStore, conversationStreamStore, attachmentStore } = await adapter.connect();
	const coordinator = createNodeAgentCoordinator({
		submissions: executionStore.submissions,
		agents: [
			{
				name: 'assistant',
				definition: defineAgent(() => {
					useModel(`${provider.getModel().provider}/${provider.getModel().id}`);
					return agentFn();
				}),
			},
		],
		createContext: makeFauxCreateContext(provider),
		conversationStreamStore,
		attachmentStore,
	});
	return { coordinator, executionStore, conversationStreamStore };
}

async function readRecords(
	conversationStreamStore: { read: (path: string) => Promise<{ batches: { records: unknown[] }[] }> },
) {
	const read = await conversationStreamStore.read(agentStreamPath('assistant', 'instance-1'));
	return read.batches.flatMap((batch) => batch.records) as Array<
		Record<string, unknown> & { type: string }
	>;
}

describe('durable tools — live execution', () => {
	it('records one awaited memo per step, keyed by tool call and step name', async () => {
		const provider = createFauxProvider();
		const toolCallId = `tool:steps-${crypto.randomUUID()}`;
		provider.setResponses([
			fauxAssistantMessage(fauxToolCall('sync', {}, { id: toolCallId }), {
				stopReason: 'toolUse',
			}),
			fauxAssistantMessage('Done.'),
		]);
		const runs: string[] = [];
		function Assistant() {
			useTool({
				name: 'sync',
				description: 'Sync.',
				input: v.object({}),
				durable: true,
				run: async ({ step }) => {
					const first = await step.do('one', () => {
						runs.push('one');
						return { value: 'first' };
					});
					const second = await step.do('two', () => {
						runs.push('two');
						return `${first.value}+second`;
					});
					return { second };
				},
			});
			return 'Assistant agent.';
		}
		const { coordinator, conversationStreamStore } = await createCoordinatorWithAgent(
			createTempDbPath(),
			provider,
			Assistant,
		);
		await coordinator.admitDispatch(makeDispatchInput());
		await coordinator.waitForIdle();

		expect(runs).toEqual(['one', 'two']);
		const records = await readRecords(conversationStreamStore);
		const memos = records.filter((record) => record.type === 'tool_step_settled');
		expect(memos).toHaveLength(2);
		expect(memos[0]).toMatchObject({
			id: toolStepRecordId(toolCallId, 'one'),
			toolCallId,
			toolName: 'sync',
			stepName: 'one',
			value: { value: 'first' },
		});
		expect(memos[1]).toMatchObject({
			id: toolStepRecordId(toolCallId, 'two'),
			stepName: 'two',
			value: 'first+second',
		});
		// Memos land BEFORE the tool outcome: each step checkpoints as it
		// completes, not when the call settles.
		const outcomeIndex = records.findIndex(
			(record) => record.type === 'tool_outcome' && record.toolCallId === toolCallId,
		);
		const lastMemoIndex = records.findLastIndex((record) => record.type === 'tool_step_settled');
		expect(outcomeIndex).toBeGreaterThan(lastMemoIndex);
		expect(records[outcomeIndex]).toMatchObject({ isError: false, output: { second: 'first+second' } });
	});

	it('scopes memos per tool call — a new call runs its steps fresh', async () => {
		const provider = createFauxProvider();
		provider.setResponses([
			fauxAssistantMessage(fauxToolCall('sync', {}, { id: 'tool-call-a' }), {
				stopReason: 'toolUse',
			}),
			fauxAssistantMessage('First done.'),
			fauxAssistantMessage(fauxToolCall('sync', {}, { id: 'tool-call-b' }), {
				stopReason: 'toolUse',
			}),
			fauxAssistantMessage('Second done.'),
		]);
		let runs = 0;
		function Assistant() {
			useTool({
				name: 'sync',
				description: 'Sync.',
				input: v.object({}),
				durable: true,
				run: ({ step }) =>
					step.do('only', () => {
						runs += 1;
						return { run: runs };
					}),
			});
			return 'Assistant agent.';
		}
		const { coordinator, conversationStreamStore } = await createCoordinatorWithAgent(
			createTempDbPath(),
			provider,
			Assistant,
		);
		await coordinator.admitDispatch(makeDispatchInput({ dispatchId: 'dispatch-a' }));
		await coordinator.waitForIdle();
		await coordinator.admitDispatch(makeDispatchInput({ dispatchId: 'dispatch-b' }));
		await coordinator.waitForIdle();

		expect(runs).toBe(2);
		const memos = (await readRecords(conversationStreamStore)).filter(
			(record) => record.type === 'tool_step_settled',
		);
		expect(memos.map((memo) => memo.id)).toEqual([
			toolStepRecordId('tool-call-a', 'only'),
			toolStepRecordId('tool-call-b', 'only'),
		]);
	});

	it('turns a reused step name into a tool error the model sees', async () => {
		const provider = createFauxProvider();
		provider.setResponses([
			fauxAssistantMessage(fauxToolCall('sync', {}, { id: 'tool-call-dup' }), {
				stopReason: 'toolUse',
			}),
			fauxAssistantMessage('Done.'),
		]);
		function Assistant() {
			useTool({
				name: 'sync',
				description: 'Sync.',
				input: v.object({}),
				durable: true,
				run: async ({ step }) => {
					await step.do('same', () => 1);
					await step.do('same', () => 2);
					return 'unreachable';
				},
			});
			return 'Assistant agent.';
		}
		const { coordinator, conversationStreamStore } = await createCoordinatorWithAgent(
			createTempDbPath(),
			provider,
			Assistant,
		);
		await coordinator.admitDispatch(makeDispatchInput());
		await coordinator.waitForIdle();

		const records = await readRecords(conversationStreamStore);
		const outcome = records.find(
			(record) => record.type === 'tool_outcome' && record.toolCallId === 'tool-call-dup',
		);
		expect(outcome).toMatchObject({ isError: true });
		expect(JSON.stringify(outcome?.content)).toContain('twice in one call');
		// The first step still checkpointed; the reused name recorded nothing.
		expect(records.filter((record) => record.type === 'tool_step_settled')).toHaveLength(1);
	});

	it('rejects a non-JSON-serializable step value as a tool error', async () => {
		const provider = createFauxProvider();
		provider.setResponses([
			fauxAssistantMessage(fauxToolCall('sync', {}, { id: 'tool-call-cyclic' }), {
				stopReason: 'toolUse',
			}),
			fauxAssistantMessage('Done.'),
		]);
		function Assistant() {
			useTool({
				name: 'sync',
				description: 'Sync.',
				input: v.object({}),
				durable: true,
				run: async ({ step }) => {
					const cyclic: Record<string, unknown> = {};
					cyclic.self = cyclic;
					await step.do('bad', () => cyclic);
					return 'unreachable';
				},
			});
			return 'Assistant agent.';
		}
		const { coordinator, conversationStreamStore } = await createCoordinatorWithAgent(
			createTempDbPath(),
			provider,
			Assistant,
		);
		await coordinator.admitDispatch(makeDispatchInput());
		await coordinator.waitForIdle();

		const records = await readRecords(conversationStreamStore);
		const outcome = records.find(
			(record) => record.type === 'tool_outcome' && record.toolCallId === 'tool-call-cyclic',
		);
		expect(outcome).toMatchObject({ isError: true });
		expect(records.filter((record) => record.type === 'tool_step_settled')).toHaveLength(0);
	});

	it('keeps step memos out of the model context', async () => {
		const provider = createFauxProvider();
		let capturedContext = '';
		provider.setResponses([
			fauxAssistantMessage(fauxToolCall('sync', {}, { id: 'tool-call-ctx' }), {
				stopReason: 'toolUse',
			}),
			fauxAssistantMessage('Done.'),
			(context) => {
				capturedContext = JSON.stringify(context.messages);
				return fauxAssistantMessage('Follow-up.');
			},
		]);
		function Assistant() {
			useTool({
				name: 'sync',
				description: 'Sync.',
				input: v.object({}),
				durable: true,
				run: async ({ step }) => {
					await step.do('secret-step', () => 'memo-only-value');
					return 'tool-result-value';
				},
			});
			return 'Assistant agent.';
		}
		const { coordinator } = await createCoordinatorWithAgent(
			createTempDbPath(),
			provider,
			Assistant,
		);
		await coordinator.admitDispatch(makeDispatchInput({ dispatchId: 'dispatch-first' }));
		await coordinator.waitForIdle();
		await coordinator.admitDispatch(makeDispatchInput({ dispatchId: 'dispatch-second' }));
		await coordinator.waitForIdle();

		// The tool's final result reaches the model; the memo value does not.
		expect(capturedContext).toContain('tool-result-value');
		expect(capturedContext).not.toContain('memo-only-value');
		expect(capturedContext).not.toContain('secret-step');
	});
});

describe('durable tools — recovery re-execution', { timeout: 30_000 }, () => {
	// The canonical durable-tool scenario end to end: a real process kill mid
	// tool-batch, one durable call with a completed step memo, one plain call.
	it('re-executes the durable call (replaying its recorded step) and markers the plain call', async () => {
		const dbPath = createTempDbPath();
		await killAtDurableToolBoundary(dbPath);
		const provider = createFauxProvider();
		provider.setResponses([fauxAssistantMessage('Continued after repair.')]);
		const stepRuns: string[] = [];
		let lookupRuns = 0;
		function Assistant() {
			useTool({
				name: 'sync',
				description: 'Sync.',
				input: v.object({}),
				durable: true,
				run: async ({ step }) => {
					const one = await step.do('one', () => {
						stepRuns.push('one');
						return 'fresh-one';
					});
					const two = await step.do('two', () => {
						stepRuns.push('two');
						return 'fresh-two';
					});
					return { one, two };
				},
			});
			useTool({
				name: 'lookup',
				description: 'Look up.',
				input: v.object({}),
				run: () => {
					lookupRuns += 1;
					return 'must not run';
				},
			});
			return 'Assistant agent.';
		}
		const { coordinator, conversationStreamStore } = await createCoordinatorWithAgent(
			dbPath,
			provider,
			Assistant,
		);
		await coordinator.reconcileSubmissions();
		await coordinator.waitForIdle();

		// Step "one" replayed from the killed attempt's memo; only "two" ran.
		expect(stepRuns).toEqual(['two']);
		// The plain tool was never re-run.
		expect(lookupRuns).toBe(0);
		const records = await readRecords(conversationStreamStore);
		const syncOutcome = records.find(
			(record) => record.type === 'tool_outcome' && record.toolCallId === 'tool-call-1',
		);
		// The replayed memo value flowed into the real outcome.
		expect(syncOutcome).toMatchObject({
			toolName: 'sync',
			isError: false,
			output: { one: 'memo-one', two: 'fresh-two' },
		});
		const lookupOutcome = records.find(
			(record) => record.type === 'tool_outcome' && record.toolCallId === 'tool-call-2',
		);
		expect(lookupOutcome).toMatchObject({ toolName: 'lookup', isError: true });
		// One repaired batch commit; step "two" gained its memo.
		expect(records.filter((record) => record.type === 'tool_results_committed')).toHaveLength(1);
		expect(
			records.filter(
				(record) =>
					record.type === 'tool_step_settled' && record.id === toolStepRecordId('tool-call-1', 'two'),
			),
		).toHaveLength(1);
	});

	it('falls back to the interrupted marker when the tool is no longer durable', async () => {
		const dbPath = createTempDbPath();
		await killAtDurableToolBoundary(dbPath);
		const provider = createFauxProvider();
		provider.setResponses([fauxAssistantMessage('Continued after repair.')]);
		let syncRuns = 0;
		function Assistant() {
			// Redeploy dropped the durable flag: recovery must NOT re-execute.
			useTool({
				name: 'sync',
				description: 'Sync.',
				input: v.object({}),
				run: () => {
					syncRuns += 1;
					return 'must not run';
				},
			});
			useTool({
				name: 'lookup',
				description: 'Look up.',
				input: v.object({}),
				run: () => 'must not run either',
			});
			return 'Assistant agent.';
		}
		const { coordinator, conversationStreamStore } = await createCoordinatorWithAgent(
			dbPath,
			provider,
			Assistant,
		);
		await coordinator.reconcileSubmissions();
		await coordinator.waitForIdle();

		expect(syncRuns).toBe(0);
		const records = await readRecords(conversationStreamStore);
		const syncOutcome = records.find(
			(record) => record.type === 'tool_outcome' && record.toolCallId === 'tool-call-1',
		);
		expect(syncOutcome).toMatchObject({ isError: true });
	});

	it('turns a throw during re-execution into an isError outcome on one attempt', async () => {
		const dbPath = createTempDbPath();
		await killAtDurableToolBoundary(dbPath);
		const provider = createFauxProvider();
		provider.setResponses([fauxAssistantMessage('Continued after repair.')]);
		function Assistant() {
			useTool({
				name: 'sync',
				description: 'Sync.',
				input: v.object({}),
				durable: true,
				run: async ({ step }) => {
					await step.do('one', () => 'never-runs-memo-exists');
					throw new Error('sync boom');
				},
			});
			useTool({
				name: 'lookup',
				description: 'Look up.',
				input: v.object({}),
				run: () => 'must not run',
			});
			return 'Assistant agent.';
		}
		const { coordinator, executionStore, conversationStreamStore } =
			await createCoordinatorWithAgent(dbPath, provider, Assistant);
		await coordinator.reconcileSubmissions();
		await coordinator.waitForIdle();

		const records = await readRecords(conversationStreamStore);
		const syncOutcome = records.find(
			(record) => record.type === 'tool_outcome' && record.toolCallId === 'tool-call-1',
		);
		expect(syncOutcome).toMatchObject({ isError: true });
		expect(JSON.stringify(syncOutcome?.content)).toContain('sync boom');
		// The throw settled the call for the model — the submission completed
		// on the single recovery attempt (the killed attempt + one recovery;
		// no further retries were burned by the tool error).
		const submission = await executionStore.submissions.getSubmission(
			'dispatch-durable-tool-repair',
		);
		expect(submission).toMatchObject({ status: 'settled', attemptCount: 2 });
	});
});

describe('durable tools — outside a session', () => {
	it('hands standalone runs an ephemeral step with identical semantics and no persistence', async () => {
		const tool = defineTool({
			name: 'sync',
			description: 'Sync.',
			durable: true,
			run: async ({ step }) => {
				const one = await step.do('one', () => ({ n: 1 }));
				await expect(step.do('one', () => ({ n: 2 }))).rejects.toThrow('twice in one call');
				return one;
			},
		});
		const parsed = parseToolInput(tool, undefined, undefined, undefined);
		const context = parsed.context as { step: ToolStep };
		expect(context.step).toBeDefined();
		await expect(tool.run(parsed.context)).resolves.toEqual({ n: 1 });
	});
});
