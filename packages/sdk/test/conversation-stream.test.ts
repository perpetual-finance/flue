import { describe, expect, it } from 'vitest';
import type { FlueConversationSnapshot } from '../src/public/conversation.ts';
import {
	applyConversationChunk,
	assertConversationStreamChunk,
	type ConversationStreamChunk,
	ConversationStreamError,
	createConversationStreamState,
} from '../src/public/conversation-stream.ts';

function emptySnapshot(): FlueConversationSnapshot {
	return { v: 1, conversationId: 'c1', offset: '-1', messages: [], settlements: [] };
}

function reduce(chunks: ConversationStreamChunk[], snapshot = emptySnapshot()) {
	let state = createConversationStreamState(snapshot);
	for (const chunk of chunks) state = applyConversationChunk(state, chunk);
	return state;
}

describe('applyConversationChunk()', () => {
	it('appends a whole user message when a message-appended chunk arrives', () => {
		const conversation = reduce([
			{
				type: 'message-appended',
				conversationId: 'c1',
				message: {
					id: 'm1',
					role: 'user',
					submissionId: 's1',
					parts: [{ type: 'text', text: 'hello', state: 'done' }],
				},
			},
		]);
		expect(conversation.messages).toEqual([
			{ id: 'm1', role: 'user', submissionId: 's1', parts: [{ type: 'text', text: 'hello', state: 'done' }] },
		]);
	});

	it('stamps assistant purpose, display, and turnId onto a message synthesized from message-started', () => {
		const conversation = reduce([
			{ type: 'message-started', conversationId: 'c1', messageId: 'a1', submissionId: 's1', turnId: 'turn_07' },
		]);
		// The live synthesis must reproduce the same classification the snapshot
		// projection emits for a completed assistant message, so a later
		// conversation-reset does not change purpose/display/turnId mid-stream.
		expect(conversation.messages[0]).toEqual({
			id: 'a1',
			role: 'assistant',
			purpose: 'assistant',
			display: 'visible',
			submissionId: 's1',
			turnId: 'turn_07',
			parts: [],
		});
	});

	it('preserves a system signal message purpose, display, and typed signal detail through message-appended', () => {
		const conversation = reduce([
			{
				type: 'message-appended',
				conversationId: 'c1',
				message: {
					id: 'sig1',
					role: 'system',
					purpose: 'dispatch',
					display: 'diagnostic',
					submissionId: 's1',
					turnId: 'turn_07',
					signal: { tagName: 'dispatch', attributes: { agent: 'planner' } },
					parts: [{ type: 'text', text: '{"input":"go"}', state: 'done' }],
				},
			},
		]);
		expect(conversation.messages[0]).toEqual({
			id: 'sig1',
			role: 'system',
			purpose: 'dispatch',
			display: 'diagnostic',
			submissionId: 's1',
			turnId: 'turn_07',
			signal: { tagName: 'dispatch', attributes: { agent: 'planner' } },
			parts: [{ type: 'text', text: '{"input":"go"}', state: 'done' }],
		});
	});

	it('assembles a streaming assistant text part from started, deltas, and completed', () => {
		const conversation = reduce([
			{ type: 'message-started', conversationId: 'c1', messageId: 'a1' },
			{ type: 'message-delta', conversationId: 'c1', messageId: 'a1', kind: 'text', delta: 'he' },
			{ type: 'message-delta', conversationId: 'c1', messageId: 'a1', kind: 'text', delta: 'llo' },
			{ type: 'message-completed', conversationId: 'c1', messageId: 'a1' },
		]);
		expect(conversation.messages[0]?.parts[0]).toEqual({ type: 'text', text: 'hello', state: 'done' });
	});

	it('carries agent-authored start metadata onto the message and preserves it through deltas and completion', () => {
		const conversation = reduce([
			{
				type: 'message-started',
				conversationId: 'c1',
				messageId: 'a1',
				metadata: { timestamp: '2026-06-25T00:00:02.000Z' },
			},
			{ type: 'message-delta', conversationId: 'c1', messageId: 'a1', kind: 'text', delta: 'hi' },
			{ type: 'message-completed', conversationId: 'c1', messageId: 'a1' },
		]);
		expect(conversation.messages[0]?.metadata).toEqual({
			timestamp: '2026-06-25T00:00:02.000Z',
		});
	});

	it('assembles a multi-step response into one message when later steps reuse the message id', () => {
		// The runtime addresses every step of a submission at the response
		// message id, so the second message-started is a no-op and step 2's parts
		// accumulate after step 1's tool call.
		const conversation = reduce([
			{ type: 'message-started', conversationId: 'c1', messageId: 'a1', submissionId: 's1' },
			{ type: 'message-delta', conversationId: 'c1', messageId: 'a1', kind: 'text', delta: 'Looking. ' },
			{ type: 'tool-input', conversationId: 'c1', messageId: 'a1', toolCallId: 'call_1', toolName: 'lookup', input: {} },
			{ type: 'message-completed', conversationId: 'c1', messageId: 'a1' },
			{ type: 'tool-output', conversationId: 'c1', toolCallId: 'call_1', output: 'found it' },
			{ type: 'message-started', conversationId: 'c1', messageId: 'a1', submissionId: 's1' },
			{ type: 'message-delta', conversationId: 'c1', messageId: 'a1', kind: 'text', delta: 'Done.' },
			{ type: 'message-completed', conversationId: 'c1', messageId: 'a1' },
		]);

		expect(conversation.messages).toHaveLength(1);
		expect(conversation.messages[0]?.parts).toEqual([
			{ type: 'text', text: 'Looking. ', state: 'done' },
			{ type: 'dynamic-tool', toolName: 'lookup', toolCallId: 'call_1', state: 'output-available', input: {}, output: 'found it', errorText: undefined },
			{ type: 'text', text: 'Done.', state: 'done' },
		]);
	});

	it('appends a data part at the live end and updates it in place on rewrite', () => {
		const conversation = reduce([
			{ type: 'message-started', conversationId: 'c1', messageId: 'a1', submissionId: 's1' },
			{ type: 'message-delta', conversationId: 'c1', messageId: 'a1', kind: 'text', delta: 'Working. ' },
			{ type: 'tool-input', conversationId: 'c1', messageId: 'a1', toolCallId: 'call_1', toolName: 'load_case', input: {} },
			{ type: 'message-completed', conversationId: 'c1', messageId: 'a1' },
			{ type: 'data-part', conversationId: 'c1', messageId: 'a1', name: 'caseCard', data: { status: 'loading' } },
			{ type: 'tool-output', conversationId: 'c1', toolCallId: 'call_1', output: 'ok' },
			{ type: 'message-started', conversationId: 'c1', messageId: 'a1', submissionId: 's1' },
			{ type: 'message-delta', conversationId: 'c1', messageId: 'a1', kind: 'text', delta: 'Done.' },
			// The rewrite reconciles by name: same part, same position, new data.
			{ type: 'data-part', conversationId: 'c1', messageId: 'a1', name: 'caseCard', data: { status: 'loaded' } },
			{ type: 'message-completed', conversationId: 'c1', messageId: 'a1' },
		]);

		expect(conversation.messages).toHaveLength(1);
		expect(conversation.messages[0]?.parts).toMatchObject([
			{ type: 'text', text: 'Working. ' },
			{ type: 'dynamic-tool', toolCallId: 'call_1', state: 'output-available' },
			{ type: 'data-caseCard', data: { status: 'loaded' } },
			{ type: 'text', text: 'Done.', state: 'done' },
		]);
	});

	it('deep-merges agent-authored metadata across the start and finish points', () => {
		const conversation = reduce([
			{
				type: 'message-started',
				conversationId: 'c1',
				messageId: 'a1',
				metadata: { op: { startedAt: 111 }, timestamp: '2026-06-25T00:00:02.000Z' },
			},
			{ type: 'message-delta', conversationId: 'c1', messageId: 'a1', kind: 'text', delta: 'hi' },
			{ type: 'message-completed', conversationId: 'c1', messageId: 'a1' },
			{
				type: 'message-metadata',
				conversationId: 'c1',
				messageId: 'a1',
				metadata: { op: { finishedAt: 222 } },
			},
		]);

		expect(conversation.messages[0]?.metadata).toEqual({
			op: { startedAt: 111, finishedAt: 222 },
			timestamp: '2026-06-25T00:00:02.000Z',
		});
	});

	it('opens a new part when the delta kind changes from reasoning to text', () => {
		const conversation = reduce([
			{ type: 'message-started', conversationId: 'c1', messageId: 'a1' },
			{ type: 'message-delta', conversationId: 'c1', messageId: 'a1', kind: 'reasoning', delta: 'thinking' },
			{ type: 'message-delta', conversationId: 'c1', messageId: 'a1', kind: 'text', delta: 'answer' },
			{ type: 'message-completed', conversationId: 'c1', messageId: 'a1' },
		]);
		expect(conversation.messages[0]?.parts).toEqual([
			{ type: 'reasoning', text: 'thinking', state: 'done' },
			{ type: 'text', text: 'answer', state: 'done' },
		]);
	});

	it('opens a new text part after a tool call rather than extending the earlier text', () => {
		const conversation = reduce([
			{ type: 'message-started', conversationId: 'c1', messageId: 'a1' },
			{ type: 'message-delta', conversationId: 'c1', messageId: 'a1', kind: 'text', delta: 'before' },
			{ type: 'tool-input', conversationId: 'c1', messageId: 'a1', toolCallId: 't1', toolName: 'noop', input: {} },
			{ type: 'message-delta', conversationId: 'c1', messageId: 'a1', kind: 'text', delta: 'after' },
			{ type: 'message-completed', conversationId: 'c1', messageId: 'a1' },
		]);
		expect(conversation.messages[0]?.parts).toEqual([
			{ type: 'text', text: 'before', state: 'done' },
			{ type: 'dynamic-tool', toolName: 'noop', toolCallId: 't1', state: 'input-available', input: {} },
			{ type: 'text', text: 'after', state: 'done' },
		]);
	});

	it('closes a streaming reasoning part when text streaming begins, before completion', () => {
		const conversation = reduce([
			{ type: 'message-started', conversationId: 'c1', messageId: 'a1' },
			{ type: 'message-delta', conversationId: 'c1', messageId: 'a1', kind: 'reasoning', delta: 'thinking' },
			{ type: 'message-delta', conversationId: 'c1', messageId: 'a1', kind: 'text', delta: 'answer' },
		]);
		expect(conversation.messages[0]?.parts).toEqual([
			{ type: 'reasoning', text: 'thinking', state: 'done' },
			{ type: 'text', text: 'answer', state: 'streaming' },
		]);
	});

	it('closes a streaming text part when a tool call begins, before completion', () => {
		const conversation = reduce([
			{ type: 'message-started', conversationId: 'c1', messageId: 'a1' },
			{ type: 'message-delta', conversationId: 'c1', messageId: 'a1', kind: 'text', delta: 'before' },
			{ type: 'tool-input', conversationId: 'c1', messageId: 'a1', toolCallId: 't1', toolName: 'noop', input: {} },
		]);
		expect(conversation.messages[0]?.parts).toEqual([
			{ type: 'text', text: 'before', state: 'done' },
			{ type: 'dynamic-tool', toolName: 'noop', toolCallId: 't1', state: 'input-available', input: {} },
		]);
	});

	it('continues a snapshot in-progress streaming block when live deltas resume after a reset', () => {
		const snapshot: FlueConversationSnapshot = {
			v: 1,
			conversationId: 'c1',
			offset: '5',
			messages: [
				{ id: 'a1', role: 'assistant', parts: [{ type: 'text', text: 'abcde', state: 'streaming' }] },
			],
			settlements: [],
		};
		const conversation = reduce(
			[
				{ type: 'message-delta', conversationId: 'c1', messageId: 'a1', kind: 'text', delta: 'fg' },
				{ type: 'message-completed', conversationId: 'c1', messageId: 'a1' },
			],
			snapshot,
		);
		expect(conversation.messages[0]?.parts[0]).toEqual({ type: 'text', text: 'abcdefg', state: 'done' });
	});

	it('creates a fresh part for an assistant message with no materialized streaming part', () => {
		const snapshot: FlueConversationSnapshot = {
			v: 1,
			conversationId: 'c1',
			offset: '5',
			// The assistant message exists but its in-progress block was not
			// materialized in the snapshot (e.g. zero deltas at the reset offset).
			messages: [{ id: 'a1', role: 'assistant', parts: [] }],
			settlements: [],
		};
		const conversation = reduce(
			[
				{ type: 'message-delta', conversationId: 'c1', messageId: 'a1', kind: 'text', delta: 'he' },
				{ type: 'message-delta', conversationId: 'c1', messageId: 'a1', kind: 'text', delta: 'llo' },
				{ type: 'message-completed', conversationId: 'c1', messageId: 'a1' },
			],
			snapshot,
		);
		expect(conversation.messages[0]?.parts[0]).toEqual({ type: 'text', text: 'hello', state: 'done' });
	});

	it('projects structured tool output onto the owning dynamic-tool part', () => {
		const conversation = reduce([
			{ type: 'message-started', conversationId: 'c1', messageId: 'a1' },
			{ type: 'tool-input', conversationId: 'c1', messageId: 'a1', toolCallId: 't1', toolName: 'weather', input: { city: 'NYC' } },
			{ type: 'tool-output', conversationId: 'c1', toolCallId: 't1', output: { temperature: 21 } },
		]);
		expect(conversation.messages[0]?.parts[0]).toEqual({
			type: 'dynamic-tool',
			toolName: 'weather',
			toolCallId: 't1',
			state: 'output-available',
			input: { city: 'NYC' },
			output: { temperature: 21 },
		});
	});

	it('replaces the whole conversation when a reset chunk arrives', () => {
		const conversation = reduce([
			{ type: 'message-appended', conversationId: 'c1', message: { id: 'm1', role: 'user', parts: [{ type: 'text', text: 'old', state: 'done' }] } },
			{
				type: 'conversation-reset',
				conversationId: 'c1',
				snapshot: {
					v: 1,
					conversationId: 'c1',
					offset: '9',
					messages: [{ id: 'm2', role: 'user', parts: [{ type: 'text', text: 'fresh', state: 'done' }] }],
					settlements: [],
				},
			},
		]);
		expect(conversation.messages).toEqual([
			{ id: 'm2', role: 'user', parts: [{ type: 'text', text: 'fresh', state: 'done' }] },
		]);
	});

	it('records a submission settlement', () => {
		const conversation = reduce([
			{ type: 'submission-settled', conversationId: 'c1', submissionId: 's1', outcome: 'completed' },
		]);
		expect(conversation.settlements).toEqual([{ submissionId: 's1', outcome: 'completed' }]);
	});
});

describe('assertConversationStreamChunk()', () => {
	it('rejects an unknown chunk shape', () => {
		expect(() => assertConversationStreamChunk({ type: 'nope' } as unknown as ConversationStreamChunk)).toThrow(
			ConversationStreamError,
		);
	});

	it('accepts a known chunk', () => {
		const chunk: ConversationStreamChunk = {
			type: 'message-delta',
			conversationId: 'c1',
			messageId: 'a1',
			kind: 'text',
			delta: 'hi',
			position: { batch: 1, index: 0 },
		};
		expect(assertConversationStreamChunk(chunk)).toBe(chunk);
	});

	it('rejects a chunk missing a valid position', () => {
		const chunk = {
			type: 'message-delta',
			conversationId: 'c1',
			messageId: 'a1',
			kind: 'text',
			delta: 'hi',
		} as unknown as ConversationStreamChunk;
		expect(() => assertConversationStreamChunk(chunk)).toThrow(ConversationStreamError);
	});
});
