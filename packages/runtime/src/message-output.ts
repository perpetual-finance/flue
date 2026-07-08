import * as v from 'valibot';
import type { FlueHarness, FlueLogger, PromptUsage } from './types.ts';

/**
 * The write channels behind the output hooks. Client-facing output
 * (`useMessageData`, `useMessageMetadata`) decorates the agent's response
 * message for clients and never reaches the model; model-facing appends
 * (`ctx.append` in `useAgentFinish`) write signal records into the agent's
 * own conversation history. Both are write-only and non-reactive — nothing
 * here re-runs the agent.
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
 * One finish-continuation append: a signal authored by agent code into the
 * current agent's conversation history. Field-for-field the code-side twin
 * of a `kind: 'signal'` delivered message (same validation, same rendering)
 * — minus delivery semantics: an append steers the response the agent is
 * producing right now and is never a delivery (no `useAgentStart` run, no
 * submission of its own).
 */
export interface AgentSignalAppend {
	type: string;
	body: string;
	attributes?: Record<string, string>;
	tagName?: string;
}

/**
 * The message shape `ctx.append` (on `AgentFinishContext`) accepts: the same
 * signal form `dispatch()` messages use, so appending and dispatching share
 * one vocabulary. Only `kind: 'signal'` is accepted — a `kind: 'user'`
 * message is real new input and belongs on `useDispatchMessage()`.
 */
export interface AgentAppendMessage extends AgentSignalAppend {
	kind: 'signal';
}

const AppendMessageSchema = v.strictObject(
	{
		kind: v.literal('signal', 'message "kind" must be "signal"'),
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

/** Validate one `ctx.append` argument; throws with field-level detail. */
export function assertAppendMessage(message: unknown): AgentSignalAppend {
	if (
		typeof message === 'object' &&
		message !== null &&
		(message as { kind?: unknown }).kind === 'user'
	) {
		throw new Error(
			'[flue] append() only appends kind: "signal" messages into the running response. A kind: "user" message is real new input — send it with the dispatcher from useDispatchMessage() instead.',
		);
	}
	const parsed = v.safeParse(AppendMessageSchema, message);
	if (!parsed.success) {
		throw new Error(
			`[flue] append() message is invalid: ${parsed.issues.map((issue) => issue.message).join('; ')}.`,
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
 * The context a `useAgentStart` callback receives. `log` emits progress lines
 * into the conversation stream (the model never sees them); `signal` is the
 * submission's abort signal; `harness` is the invocation-scoped runtime
 * surface (sandbox `shell`/`fs`, child sessions, model calls) — materialized
 * lazily on first access, so a callback that never touches it pays nothing.
 * To put something in front of the model, dispatch a signal with the
 * dispatcher from `useDispatchMessage()` — it joins this same response
 * before the model's next turn. `append` is the low-level alternative
 * (parity with `useAgentFinish`): it writes a signal into this response
 * WITHOUT registering a delivery — no `useAgentStart` run of its own, no
 * submission — and is legal only during the callback's execution window.
 * Prefer dispatching; reach for `append` only when a delivery is wrong.
 */
export interface AgentStartContext {
	readonly append: (message: AgentAppendMessage) => void;
	readonly harness: FlueHarness;
	readonly log: FlueLogger;
	readonly signal: AbortSignal;
}

/** One tool call the current response has made, from the durable record log. */
export interface AgentResponseToolCall {
	/** The tool's name as the model called it. */
	tool: string;
	/** Whether the call's recorded outcome was an error. */
	isError: boolean;
}

/**
 * The context a `useAgentFinish` callback receives: the `useAgentStart`
 * surface plus visibility into the response so far and the continuation
 * writer. `response.toolCalls` aggregates every tool call the response has
 * made — across all turns and across re-attempts (derived from durable
 * records, so a resumed response still sees calls made before an
 * interruption). `append` steers a signal into the same response — the model
 * reads it on the continuation turn and this hook fires again at the next
 * would-stop — and is legal only during the callback's execution window
 * (a captured reference throws after the callback settles). Appends are the
 * response steering itself: no `useAgentStart` run, no submission of their
 * own, counted against the framework's continuation ceiling. For real new
 * input, dispatch instead.
 */
export interface AgentFinishContext {
	readonly response: { readonly toolCalls: readonly AgentResponseToolCall[] };
	readonly append: (message: AgentAppendMessage) => void;
	readonly harness: FlueHarness;
	readonly log: FlueLogger;
	readonly signal: AbortSignal;
}

/** One `useAgentStart` declaration; identity is the declaration index. */
export interface AgentStartDeclaration {
	run: (ctx: AgentStartContext) => void | Promise<void>;
}

/** One `useAgentFinish` declaration; identity is the declaration index. */
export interface AgentFinishDeclaration {
	run: (ctx: AgentFinishContext) => void | Promise<void>;
}

/**
 * The output channel shared between renders and the session, mirroring the
 * `useState` buffer pattern: created once per harness lifetime, handed to
 * both sides. Renders replace `producers` and the lifecycle declarations
 * wholesale each render (fresh closures); `useMessageData` writers call
 * `writeMessageData`; the session connects the sink that reaches the
 * durable log. (Finish-continuation appends never pass through here: the
 * session constructs `ctx.append` directly when it runs the callbacks.)
 */
export interface AgentOutputChannel {
	/** Metadata producers from the latest render. */
	producers: MessageMetadataProducers;
	/** `useAgentStart` declarations from the latest render, in call order. */
	agentStarts: AgentStartDeclaration[];
	/** `useAgentFinish` declarations from the latest render, in call order. */
	agentFinishes: AgentFinishDeclaration[];
	/** Wire the session-side sink data writes flow into. */
	connect(sink: (name: string, data: unknown) => void): void;
	writeMessageData(name: string, data: unknown): void;
}

export function createAgentOutputChannel(): AgentOutputChannel {
	let sink: ((name: string, data: unknown) => void) | undefined;
	return {
		producers: { start: [], finish: [] },
		agentStarts: [],
		agentFinishes: [],
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
