import type { ConversationStreamChunk } from '@flue/sdk';

type TranscriptTone = 'normal' | 'dim' | 'error' | 'success' | 'accent' | 'user';

export interface TranscriptRecord {
	readonly id: number;
	readonly text: string;
	readonly tone: TranscriptTone;
	readonly layout?: 'thinking';
}

export interface ConsoleTranscript {
	readonly records: readonly TranscriptRecord[];
	readonly nextId: number;
	readonly streaming: Readonly<Record<string, string>>;
}

export type TranscriptAction =
	| { type: 'event'; event: ConversationStreamChunk }
	| { type: 'prompt'; message: string }
	| { type: 'error'; error: unknown }
	| { type: 'clear-streaming' };

const TRANSCRIPT_LIMIT = 1000;
const DETAIL_LIMIT = 240;

export function createConsoleTranscript(): ConsoleTranscript {
	return { records: [], nextId: 0, streaming: {} };
}

export function reduceConsoleTranscript(
	state: ConsoleTranscript,
	action: TranscriptAction,
): ConsoleTranscript {
	if (action.type === 'prompt') return append(state, action.message, 'user');
	if (action.type === 'error') return append({ ...state, streaming: {} }, `error  ${errorMessage(action.error)}`, 'error');
	if (action.type === 'clear-streaming') return { ...state, streaming: {} };
	return reduceChunk(state, action.event);
}

function reduceChunk(state: ConsoleTranscript, chunk: ConversationStreamChunk): ConsoleTranscript {
	switch (chunk.type) {
		case 'message-delta': {
			// A `kind` change closes the previous streaming block into a record;
			// streaming content for the current kind accumulates until then or until
			// the message completes.
			const other = chunk.kind === 'text' ? 'reasoning' : 'text';
			const flushed = flushStreamingKind(state, other);
			return {
				...flushed,
				streaming: { ...flushed.streaming, [chunk.kind]: `${flushed.streaming[chunk.kind] ?? ''}${chunk.delta}` },
			};
		}
		case 'message-completed':
			return flushStreamingKind(flushStreamingKind(state, 'reasoning'), 'text');
		case 'tool-input': {
			const flushed = flushStreamingKind(flushStreamingKind(state, 'reasoning'), 'text');
			return append(flushed, `tool  ${chunk.toolName} ${toolDetail(chunk.toolName, chunk.input)}`, 'dim');
		}
		case 'tool-output':
			return append(state, `tool done  ${detail(chunk.output)}`, 'dim');
		case 'tool-output-error':
			return append(state, `tool failed  ${detail(chunk.errorText)}`, 'error');
		case 'submission-settled':
			return chunk.outcome === 'failed'
				? append({ ...state, streaming: {} }, `error  ${errorMessage(chunk.error)}`, 'error')
				: { ...state, streaming: {} };
		default:
			return state;
	}
}

function flushStreamingKind(
	state: ConsoleTranscript,
	kind: 'text' | 'reasoning',
): ConsoleTranscript {
	const value = state.streaming[kind];
	if (value === undefined) return state;
	const { [kind]: _removed, ...streaming } = state.streaming;
	if (!value) return { ...state, streaming };
	return kind === 'reasoning'
		? append({ ...state, streaming }, `Thinking...\n${value}`, 'dim', 'thinking')
		: append({ ...state, streaming }, value, 'normal');
}

function append(
	state: ConsoleTranscript,
	raw: string,
	tone: TranscriptTone,
	layout?: TranscriptRecord['layout'],
): ConsoleTranscript {
	const text = layout === 'thinking'
		? raw.split('\n').map(sanitize).filter(Boolean).join('\n')
		: sanitize(raw);
	if (!text) return state;
	const records = [...state.records, { id: state.nextId, text, tone, layout }].slice(-TRANSCRIPT_LIMIT);
	return { ...state, records, nextId: state.nextId + 1 };
}

export function transcriptPendingRecords(state: ConsoleTranscript): readonly TranscriptRecord[] {
	return Object.values(state.streaming)
		.filter(Boolean)
		.map((text, index) => ({ id: state.nextId + index, text: sanitize(text), tone: 'normal' as const }));
}

function sanitize(value: string): string {
	let clean = '';
	let escapeState: 'none' | 'start' | 'csi' | 'osc' | 'oscEscape' = 'none';
	for (const character of value) {
		const code = character.codePointAt(0) ?? 0;
		if (escapeState === 'osc' && code === 27) {
			escapeState = 'oscEscape';
			continue;
		}
		if (escapeState === 'oscEscape') {
			escapeState = character === '\\' ? 'none' : 'osc';
			continue;
		}
		if (code === 27) {
			escapeState = 'start';
			continue;
		}
		if (escapeState === 'start') {
			escapeState = character === '[' ? 'csi' : character === ']' ? 'osc' : 'none';
			continue;
		}
		if (escapeState === 'csi') {
			if (code >= 64 && code <= 126) escapeState = 'none';
			continue;
		}
		if (escapeState === 'osc') {
			if (code === 7) escapeState = 'none';
			continue;
		}
		if ((code >= 0 && code <= 8) || (code >= 11 && code <= 31) || (code >= 127 && code <= 159)) {
			clean += code === 9 || code === 10 || code === 13 ? ' ' : '';
			continue;
		}
		clean += character;
	}
	return clean.replace(/\s+/g, ' ').trim();
}

function detail(value: unknown): string {
	let text: string;
	try {
		text = typeof value === 'string' ? value : JSON.stringify(value);
	} catch {
		text = String(value);
	}
	const clean = sanitize(text ?? String(value));
	return clean.length > DETAIL_LIMIT ? `${clean.slice(0, DETAIL_LIMIT - 1)}…` : clean;
}

function errorMessage(error: unknown): string {
	if (error instanceof Error) return detail(error.message);
	if (isRecord(error) && typeof error.message === 'string') return detail(error.message);
	return detail(error);
}

function toolDetail(name: string, args: unknown): string {
	if (!isRecord(args)) return '';
	const key = name === 'bash' || name === 'shell' ? 'command' : name === 'grep' || name === 'glob' ? 'pattern' : 'path';
	const value = args[key];
	return typeof value === 'string' ? detail(value) : '';
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}
