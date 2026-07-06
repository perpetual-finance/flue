import type { PromptUsage } from './types.ts';

/**
 * Client-facing message output: the shared plumbing behind the output hooks
 * (`useMessageData`, `useMessageMetadata`). Output is write-only and
 * non-reactive — it decorates the agent's response message for clients and
 * never re-runs the agent or reaches the model.
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
 * The output channel shared between renders and the session, mirroring the
 * `useState` buffer pattern: created once per harness lifetime, handed to
 * both sides. Renders replace `producers` wholesale each render (fresh
 * closures) and `useMessageData` writers call `writeMessageData`; the session
 * connects the sink that appends durable records.
 */
export interface AgentOutputChannel {
	/** Metadata producers from the latest render. */
	producers: MessageMetadataProducers;
	/** Wire the session-side sink data writes flow into. */
	connect(sink: (name: string, data: unknown) => void): void;
	writeMessageData(name: string, data: unknown): void;
}

export function createAgentOutputChannel(): AgentOutputChannel {
	let sink: ((name: string, data: unknown) => void) | undefined;
	return {
		producers: { start: [], finish: [] },
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
