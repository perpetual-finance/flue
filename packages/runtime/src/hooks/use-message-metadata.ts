import type {
	MessageMetadataEvent,
	MessageMetadataPoint,
	MessageMetadataProducer,
} from '../message-output.ts';
import { requireRenderFrame } from './frame.ts';

/**
 * Attach a synchronous metadata producer to the response message.
 *
 * `'start'` runs once per response, before the first model call; `'finish'`
 * runs after the response's last model step completes, with the response's
 * aggregate usage on the event. Whatever the producer returns is deep-merged
 * onto the response message's `metadata` (multiple producers compose in call
 * order; `undefined` values are skipped). The server-authored keys —
 * `timestamp`, `usage`, `model` — are reserved and never overridden.
 *
 * ```ts
 * function useTimestamps() {
 *   useMessageMetadata('start', () => ({ createdAt: Date.now() }));
 *   useMessageMetadata('finish', () => ({ finishedAt: Date.now() }));
 * }
 *
 * function useUsageStats() {
 *   useMessageMetadata('finish', (event) => ({ totalTokens: event.usage.totalTokens }));
 * }
 * ```
 *
 * Output is non-reactive and model-invisible: producers never re-run the
 * agent and their output never reaches the prompt. Producers are fail-fast —
 * a throw fails the submission (settled `failed`, no retry, no recovery);
 * handle expected errors inside the producer.
 */
export function useMessageMetadata<TPoint extends MessageMetadataPoint>(
	point: TPoint,
	produce: (
		event: Extract<MessageMetadataEvent, { point: TPoint }>,
	) => Record<string, unknown> | undefined,
): void {
	const frame = requireRenderFrame('useMessageMetadata');
	if (frame.kind === 'subagent') {
		throw new Error(
			"[flue] useMessageMetadata() is not available in a subagent render. Message metadata decorates the agent's public conversation; delegates run detached tasks with no client-facing output.",
		);
	}
	if (point !== 'start' && point !== 'finish') {
		throw new Error(
			`[flue] useMessageMetadata() point must be 'start' or 'finish' (got ${JSON.stringify(point)}).`,
		);
	}
	if (typeof produce !== 'function') {
		throw new Error('[flue] useMessageMetadata() requires a producer function.');
	}
	// The overloaded point/produce pairing is enforced above and at the call
	// site; the per-point list accepts the matching producer shape.
	(frame.metadataProducers[point] as MessageMetadataProducer[]).push(
		produce as MessageMetadataProducer,
	);
}
