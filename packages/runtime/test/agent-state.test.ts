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
import type { ConversationRecord, StateWriteRecord } from '../src/conversation-records.ts';
import {
	createReducedInstanceState,
	reduceConversationRecords,
} from '../src/conversation-reducer.ts';
import { renderAgentFunction } from '../src/hooks/render.ts';
import { createHookStateBuffer, type StateSetter, useState } from '../src/hooks/state.ts';
import { use } from '../src/hooks/use.ts';
import { useTool } from '../src/hooks/use-tool.ts';
import { createFlueContext, type DispatchInput } from '../src/internal.ts';
import { createNodeAgentCoordinator } from '../src/node/agent-coordinator.ts';
import { sqlite } from '../src/node/agent-execution-store.ts';
import type { CreateAgentContextFn } from '../src/runtime/handle-agent.ts';
import { agentStreamPath } from '../src/runtime/stream-offsets.ts';
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
		provider: `agent-state-test-${crypto.randomUUID()}`,
	});
	providers.push(provider);
	return provider;
}

function createTempDbPath(): string {
	const dir = mkdtempSync(join(tmpdir(), 'flue-agent-state-'));
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

const CONFIG = { model: 'faux/agent-state' };

function renderStateContext(entries: [string, unknown][] = []) {
	const snapshot = new Map(entries);
	return { snapshot, store: createHookStateBuffer(snapshot) };
}

describe('useState (render)', () => {
	it('returns the default when nothing is persisted, undefined without one', () => {
		renderAgentFunction(
			() => {
				const [count] = useState({ name: 'count', default: 0 });
				const [note] = useState({ name: 'note' });
				expect(count).toBe(0);
				expect(note).toBeUndefined();
			},
			CONFIG,
			renderStateContext(),
		);
	});

	it('reads the persisted snapshot value over the default', () => {
		renderAgentFunction(
			() => {
				const [count] = useState({ name: 'count', schema: v.number(), default: 0 });
				expect(count).toBe(7);
			},
			CONFIG,
			renderStateContext([['count', 7]]),
		);
	});

	it('reads its own buffered writes over the snapshot (read-your-writes)', () => {
		const state = renderStateContext([['count', 1]]);
		state.store.write('count', 2);
		renderAgentFunction(
			() => {
				const [count] = useState({ name: 'count', default: 0 });
				expect(count).toBe(2);
			},
			CONFIG,
			state,
		);
	});

	it('throws on a duplicate name in one render', () => {
		expect(() =>
			renderAgentFunction(
				() => {
					useState({ name: 'count' });
					useState({ name: 'count' });
				},
				CONFIG,
				renderStateContext(),
			),
		).toThrow(/Duplicate useState name "count"/);
	});

	it('throws outside an agent render', () => {
		expect(() => useState({ name: 'count' })).toThrow(/outside an agent function/);
	});

	it('throws when written during render', () => {
		renderAgentFunction(
			() => {
				const [, setCount] = useState({ name: 'count', default: 0 });
				expect(() => setCount(1)).toThrow(/written during render/);
			},
			CONFIG,
			renderStateContext(),
		);
	});

	it('throws on writes when the render has no durable runtime behind it', () => {
		let setCount: StateSetter<number> | undefined;
		renderAgentFunction(() => {
			[, setCount] = useState({ name: 'count', default: 0 });
		}, CONFIG);
		expect(() => setCount?.(1)).toThrow(/no durable runtime/);
	});

	it('validates options: unknown fields and empty names throw', () => {
		expect(() =>
			renderAgentFunction(
				() => {
					useState({ name: 'count', persist: true } as never);
				},
				CONFIG,
				renderStateContext(),
			),
		).toThrow(/unknown useState option/);
		expect(() =>
			renderAgentFunction(
				() => {
					useState({ name: '' });
				},
				CONFIG,
				renderStateContext(),
			),
		).toThrow(/useState\(\) options are invalid/);
	});

	it('validates the default against the schema', () => {
		expect(() =>
			renderAgentFunction(
				() => {
					useState({ name: 'count', schema: v.number(), default: 'nope' as never });
				},
				CONFIG,
				renderStateContext(),
			),
		).toThrow(/default does not match its schema/);
	});

	it('throws when a persisted value no longer parses under the schema', () => {
		expect(() =>
			renderAgentFunction(
				() => {
					useState({ name: 'count', schema: v.number(), default: 0 });
				},
				CONFIG,
				renderStateContext([['count', 'legacy']]),
			),
		).toThrow(/Persisted value for state "count" does not match its schema/);
	});

	it('rejects invalid, undefined, and non-serializable written values', () => {
		let setCount: StateSetter<number> | undefined;
		let setAny: StateSetter<unknown> | undefined;
		renderAgentFunction(
			() => {
				[, setCount] = useState({ name: 'count', schema: v.number(), default: 0 });
				[, setAny] = useState({ name: 'anything' });
			},
			CONFIG,
			renderStateContext(),
		);
		expect(() => setCount?.('x' as never)).toThrow(/does not match its schema/);
		expect(() => setAny?.(undefined)).toThrow(/cannot be set to undefined/);
		const circular: Record<string, unknown> = {};
		circular.self = circular;
		expect(() => setAny?.(circular)).toThrow(/not JSON-serializable/);
	});
});

describe('hook state buffer', () => {
	it('tracks previousValue and coalesces same-value writes', () => {
		const buffer = createHookStateBuffer(new Map<string, unknown>([['a', 5]]));
		buffer.write('a', 5); // equal to snapshot -> no-op
		buffer.write('a', 6);
		buffer.write('a', 6); // equal to overlay -> no-op
		buffer.write('b', { x: 1 });
		expect(buffer.drain()).toEqual([
			{ name: 'a', value: 6, previousValue: 5 },
			{ name: 'b', value: { x: 1 }, previousValue: undefined },
		]);
		// drain clears; a subsequent change is tracked against the overlay
		buffer.write('a', 7);
		expect(buffer.drain()).toEqual([{ name: 'a', value: 7, previousValue: 6 }]);
	});
});

describe('state_write reduction', () => {
	const ts = new Date().toISOString();
	const envelope = (id: string) => ({
		v: 1 as const,
		id,
		conversationId: 'c1',
		harness: 'default',
		session: 'main',
		timestamp: ts,
	});
	const created: ConversationRecord = {
		...envelope('r-created'),
		type: 'conversation_created',
		kind: 'root',
		affinityKey: 'affinity',
		createdAt: ts,
	};
	const write = (id: string, name: string, value: unknown): ConversationRecord => ({
		...envelope(id),
		type: 'state_write',
		name,
		value,
	});

	it('projects last-write-wins instance state from the record log', () => {
		const reduced = reduceConversationRecords(
			createReducedInstanceState(),
			[created, write('r1', 'count', 1), write('r2', 'count', 2), write('r3', 'phase', 'draft')],
			'3',
		);
		expect(reduced.state.get('count')).toBe(2);
		expect(reduced.state.get('phase')).toBe('draft');
	});

	it('does not mutate the input state (clone isolation)', () => {
		const base = reduceConversationRecords(
			createReducedInstanceState(),
			[created, write('r1', 'count', 1)],
			'1',
		);
		const next = reduceConversationRecords(base, [write('r2', 'count', 2)], '2');
		expect(base.state.get('count')).toBe(1);
		expect(next.state.get('count')).toBe(2);
	});
});

describe('useState end to end (node coordinator, faux provider)', () => {
	it('persists tool writes atomically with the tool batch and reads them fresh at the next run', async () => {
		const dbPath = createTempDbPath();
		const adapter = sqlite(dbPath);
		await adapter.migrate?.();
		const { executionStore, conversationStreamStore, attachmentStore } = await adapter.connect();
		const provider = createFauxProvider();
		provider.setResponses([
			// dispatch 1: bump the counter, then finish
			fauxAssistantMessage(fauxToolCall('bump', {}, { id: 'tool:bump-1' }), {
				stopReason: 'toolUse',
			}),
			fauxAssistantMessage('Bumped.'),
			// dispatch 2: write the same value again (must not produce a record)
			fauxAssistantMessage(fauxToolCall('rewrite_same', {}, { id: 'tool:same-1' }), {
				stopReason: 'toolUse',
			}),
			fauxAssistantMessage('Unchanged.'),
		]);

		const renderedCounts: number[] = [];
		function assistant() {
			const [count, setCount] = useState({ name: 'count', schema: v.number(), default: 0 });
			renderedCounts.push(count);
			useTool({
				name: 'bump',
				description: 'Increment the counter.',
				input: v.object({}),
				run: () => {
					setCount(count + 1);
					return 'ok';
				},
			});
			useTool({
				name: 'rewrite_same',
				description: 'Write the current value again.',
				input: v.object({}),
				run: () => {
					setCount(count);
					return 'ok';
				},
			});
			return `count=${count}`;
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

		await coordinator.admitDispatch(makeDispatchInput({ dispatchId: 'dispatch:state-1' }));
		await coordinator.waitForIdle();
		await coordinator.admitDispatch(makeDispatchInput({ dispatchId: 'dispatch:state-2' }));
		await coordinator.waitForIdle();
		await coordinator.shutdown();

		const { batches } = await conversationStreamStore.read(
			agentStreamPath('assistant', 'instance-1'),
		);
		const writes = batches
			.flatMap((batch) => batch.records)
			.filter((record): record is StateWriteRecord => record.type === 'state_write');
		// The bump wrote once; the same-value rewrite was a no-op.
		expect(writes).toHaveLength(1);
		expect(writes[0]).toMatchObject({ name: 'count', value: 1 });
		// No durable previous value existed: the default is never persisted.
		expect(writes[0]).not.toHaveProperty('previousValue');

		// Atomicity: the write landed in the same append batch as the tool
		// batch's commit marker, before it.
		const batch = batches.find((candidate) =>
			candidate.records.some((record) => record.type === 'state_write'),
		);
		expect(batch).toBeDefined();
		const types = (batch?.records ?? []).map((record) => record.type);
		expect(types.indexOf('state_write')).toBeLessThan(types.indexOf('tool_results_committed'));
		expect(types.indexOf('tool_results_committed')).toBeGreaterThan(-1);

		// Fresh at next run: the first render read the default, the render for
		// the second dispatch read the persisted 1.
		expect(renderedCounts[0]).toBe(0);
		expect(renderedCounts.at(-1)).toBe(1);
	});

	it('re-renders per turn: mid-run writes reach the next model call (fresh closures + prompt)', async () => {
		const dbPath = createTempDbPath();
		const adapter = sqlite(dbPath);
		await adapter.migrate?.();
		const { executionStore, conversationStreamStore, attachmentStore } = await adapter.connect();
		const provider = createFauxProvider();
		const laterPrompts: string[] = [];
		provider.setResponses([
			// turn 1: bump the counter (writes count=1 mid-run)
			fauxAssistantMessage(fauxToolCall('bump', {}, { id: 'tool:rt-bump' }), {
				stopReason: 'toolUse',
			}),
			// turn 2: read the counter through the re-rendered closure; capture
			// the recomposed system prompt this call actually ran with
			(context) => {
				laterPrompts.push(context.systemPrompt ?? '');
				return fauxAssistantMessage(fauxToolCall('read_count', {}, { id: 'tool:rt-read' }), {
					stopReason: 'toolUse',
				});
			},
			fauxAssistantMessage('Done.'),
		]);

		function assistant() {
			const [count, setCount] = useState({ name: 'count', schema: v.number(), default: 0 });
			useTool({
				name: 'bump',
				description: 'Increment the counter.',
				input: v.object({}),
				run: () => {
					setCount(count + 1);
					return 'ok';
				},
			});
			useTool({
				name: 'read_count',
				description: 'Read the counter.',
				input: v.object({}),
				run: () => String(count),
			});
			return `count=${count}`;
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

		await coordinator.admitDispatch(
			makeDispatchInput({ dispatchId: 'dispatch:per-turn', id: 'instance-per-turn' }),
		);
		await coordinator.waitForIdle();
		await coordinator.shutdown();

		const records = (
			await conversationStreamStore.read(agentStreamPath('assistant', 'instance-per-turn'))
		).batches.flatMap((batch) => batch.records);
		// The SAME submission's second turn read the value written in the first:
		// the tool executed was a fresh closure from the per-turn re-render.
		const read = records.find(
			(record) => record.type === 'tool_outcome' && record.toolCallId === 'tool:rt-read',
		);
		expect(read).toMatchObject({ content: [{ type: 'text', text: '"1"' }] });
		// And the second model call's prompt was recomposed with the new value.
		expect(laterPrompts[0]).toContain('count=1');
	});

	it('fails the run when a render changes structure mid-run (conditional use)', async () => {
		const dbPath = createTempDbPath();
		const adapter = sqlite(dbPath);
		await adapter.migrate?.();
		const { executionStore, conversationStreamStore, attachmentStore } = await adapter.connect();
		const provider = createFauxProvider();
		provider.setResponses([
			fauxAssistantMessage(fauxToolCall('bump', {}, { id: 'tool:inv-bump' }), {
				stopReason: 'toolUse',
			}),
			fauxAssistantMessage('Should never be reached.'),
		]);

		function Extra() {
			return 'Conditionally mounted — illegal.';
		}
		function assistant() {
			const [count, setCount] = useState({ name: 'count', schema: v.number(), default: 0 });
			if (count > 0) use(Extra);
			useTool({
				name: 'bump',
				description: 'Increment the counter.',
				input: v.object({}),
				run: () => {
					setCount(count + 1);
					return 'ok';
				},
			});
			return 'invariance test agent';
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

		await coordinator.admitDispatch(
			makeDispatchInput({ dispatchId: 'dispatch:invariance', id: 'instance-invariance' }),
		);
		await coordinator.waitForIdle();
		await coordinator.shutdown();

		const records = (
			await conversationStreamStore.read(agentStreamPath('assistant', 'instance-invariance'))
		).batches.flatMap((batch) => batch.records);
		// The invariance throw lands as pi's synthesized error-completed
		// assistant message: the run stops, the scripted second reply is never
		// requested, and the error names the violation.
		const finalAssistant = records
			.filter((record) => record.type === 'assistant_message_completed')
			.at(-1);
		expect(finalAssistant).toMatchObject({ stopReason: 'error' });
		expect(JSON.stringify(finalAssistant)).toContain('changed structure between turns');
		expect(JSON.stringify(finalAssistant)).toContain('Extra');
		expect(JSON.stringify(records)).not.toContain('Should never be reached.');
	});
});
