import * as v from 'valibot';
import type { FlueHarness, FlueLogger, PromptUsage } from './types.ts';

/**
 * The write channels behind the output hooks. Client-facing output
 * (`useMessageData`, `useMessageMetadata`) decorates the agent's response
 * message for clients and never reaches the model; model-facing appends
 * (an effect's `append`) write signal records into the agent's own
 * conversation history. Both are write-only and non-reactive — nothing here
 * re-runs the agent.
 */

/** Lifecycle points a `useMessageMetadata` producer can attach to. */
export type MessageMetadataPoint = 'start' | 'finish';

/**
 * The event handed to a metadata producer. `start` fires once per response,
 * before the first model call; `finish` fires after the response's last model
 * step completes, with the response's aggregate usage.
 */
export type MessageMetadataEvent =
	| { point: 'start'; submissionId: string }
	| { point: 'finish'; submissionId: string; usage: PromptUsage };

/**
 * A synchronous metadata producer. The returned object is deep-merged onto
 * the response message's metadata; `undefined` values are skipped. Producers
 * are fail-fast: a throw fails the submission.
 */
export type MessageMetadataProducer<TPoint extends MessageMetadataPoint = MessageMetadataPoint> = (
	event: Extract<MessageMetadataEvent, { point: TPoint }>,
) => Record<string, unknown> | undefined;

/** Producer lists collected from one render, in call order per point. */
export interface MessageMetadataProducers {
	start: MessageMetadataProducer<'start'>[];
	finish: MessageMetadataProducer<'finish'>[];
}

/**
 * One `append()` call from an effect: a signal authored by agent code into
 * the current agent's conversation history. Field-for-field the code-side
 * twin of a `kind: 'signal'` delivered message (same validation, same
 * rendering) — minus delivery semantics: an append annotates the running
 * submission and never wakes the agent.
 */
export interface AgentSignalAppend {
	type: string;
	body: string;
	attributes?: Record<string, string>;
	tagName?: string;
}

const SignalAppendSchema = v.strictObject(
	{
		type: v.pipe(v.string(), v.nonEmpty('signal "type" must not be empty')),
		body: v.string('signal "body" must be a string'),
		attributes: v.optional(v.record(v.string(), v.string())),
		// The tag name is rendered unescaped as the signal's XML envelope in
		// model context, so it must be a valid XML name — anything looser would
		// let a caller-controlled value inject markup that the body/attribute
		// escaping exists to prevent. Same rule as delivered signal messages.
		tagName: v.optional(
			v.pipe(
				v.string(),
				v.regex(
					/^[A-Za-z_][A-Za-z0-9_.-]*$/,
					'signal "tagName" must be a valid XML tag name ' +
						'(letters, digits, "_", "-", "."; must not start with a digit, "-", or ".")',
				),
			),
		),
	},
	(issue) =>
		issue.expected === 'never' ? `received unknown signal field ${issue.received}` : issue.message,
);

/** Validate one effect `append()` argument; throws with field-level detail. */
export function assertSignalAppend(signal: unknown): AgentSignalAppend {
	const parsed = v.safeParse(SignalAppendSchema, signal);
	if (!parsed.success) {
		throw new Error(
			`[flue] append() signal is invalid: ${parsed.issues.map((issue) => issue.message).join('; ')}.`,
		);
	}
	const { type, body, attributes, tagName } = parsed.output;
	return {
		type,
		body,
		...(attributes ? { attributes } : {}),
		...(tagName ? { tagName } : {}),
	};
}

/**
 * The context a `useEffect` run callback receives. `log` emits progress lines
 * into the conversation stream (the model never sees them); `append` writes a
 * signal into the running submission — durable and flushed live, ordered
 * before the model's next turn, atomic with the effect's outcome batch;
 * `signal` is the submission's abort signal; `harness` is the
 * invocation-scoped runtime surface (sandbox `shell`/`fs`, child sessions,
 * model calls) — available on every effect, materialized lazily on first
 * access, so an effect that never touches it pays nothing.
 *
 * Transitional: `useEffect` (and with it this context) is slated to be
 * replaced by event hooks mapped to pi events (onSessionStart, onToolCall,
 * ...); `append` rides along until then rather than surviving as standalone
 * API.
 */
export interface EffectContext {
	readonly harness: FlueHarness;
	readonly log: FlueLogger;
	readonly append: (signal: AgentSignalAppend) => void;
	readonly signal: AbortSignal;
}

/**
 * One `useEffect` declaration from a render: the run callback plus the JSON
 * fingerprint of its deps array, computed at render time. Identity is the
 * declaration index (position in this list).
 */
export interface AgentEffectDeclaration {
	run: (ctx: EffectContext) => void | Promise<void>;
	fingerprint: string;
}

/**
 * The output channel shared between renders and the session, mirroring the
 * `useState` buffer pattern: created once per harness lifetime, handed to
 * both sides. Renders replace `producers` and `effects` wholesale each render
 * (fresh closures); `useMessageData` writers call `writeMessageData`; the
 * session connects the sink that appends durable records.
 */
export interface AgentOutputChannel {
	/** Metadata producers from the latest render. */
	producers: MessageMetadataProducers;
	/** `useEffect` declarations from the latest render, in call order. */
	effects: AgentEffectDeclaration[];
	/** Wire the session-side sink data writes flow into. */
	connect(sink: (name: string, data: unknown) => void): void;
	writeMessageData(name: string, data: unknown): void;
}

export function createAgentOutputChannel(): AgentOutputChannel {
	let sink: ((name: string, data: unknown) => void) | undefined;
	return {
		producers: { start: [], finish: [] },
		effects: [],
		connect(next) {
			sink = next;
		},
		writeMessageData(name, data) {
			if (!sink) {
				throw new Error(
					`[flue] Message data "${name}" has no durable runtime behind this render, so writes are unavailable.`,
				);
			}
			sink(name, data);
		},
	};
}

/**
 * Run one point's producers in call order and deep-merge their results.
 * Fail-fast on purpose: a producer throw propagates (wrapped with the point
 * for context) and fails the submission through the normal failure path — it
 * is never retried and never enters durability recovery.
 */
export function runMessageMetadataProducers<TPoint extends MessageMetadataPoint>(
	producers: readonly MessageMetadataProducer<TPoint>[],
	event: Extract<MessageMetadataEvent, { point: TPoint }>,
): Record<string, unknown> | undefined {
	let merged: Record<string, unknown> | undefined;
	for (const produce of producers) {
		let result: Record<string, unknown> | undefined;
		try {
			result = produce(event);
		} catch (error) {
			throw new Error(
				`[flue] A useMessageMetadata('${event.point}') producer threw: ${error instanceof Error ? error.message : String(error)}`,
				{ cause: error },
			);
		}
		if (result === undefined || result === null) continue;
		if (typeof result !== 'object' || Array.isArray(result)) {
			throw new Error(
				`[flue] A useMessageMetadata('${event.point}') producer must return a plain object of metadata (got ${Array.isArray(result) ? 'an array' : typeof result}).`,
			);
		}
		merged = deepMergeMetadata(merged ?? {}, result);
	}
	return merged && Object.keys(merged).length > 0 ? merged : undefined;
}

/**
 * Deep-merge metadata objects: later values win, `undefined` is skipped,
 * plain objects merge recursively, and prototype-polluting keys are dropped.
 * Always returns a fresh object — inputs are never mutated (reducer state
 * relies on this for cheap cloning).
 */
export function deepMergeMetadata(
	base: Record<string, unknown>,
	next: Record<string, unknown>,
): Record<string, unknown> {
	const merged: Record<string, unknown> = { ...base };
	for (const [key, value] of Object.entries(next)) {
		if (value === undefined) continue;
		if (key === '__proto__' || key === 'constructor' || key === 'prototype') continue;
		const current = merged[key];
		merged[key] =
			isPlainObject(current) && isPlainObject(value) ? deepMergeMetadata(current, value) : value;
	}
	return merged;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
	const proto = Object.getPrototypeOf(value);
	return proto === Object.prototype || proto === null;
}
