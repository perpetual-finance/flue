import { type AgentAppendMessage, assertAppendMessage } from '../message-output.ts';
import { isRendering, requireRenderFrame } from './frame.ts';

/**
 * Get a writer that appends a signal message into the agent's own running
 * response. The counterpart to `useDispatchMessage()`: a dispatch is real new
 * input — a new durable submission that wakes the agent — while an append
 * annotates the response the agent is producing right now. The model reads
 * the signal at the next turn boundary; the append is durable, ordered
 * exactly where the live loop saw it, and never wakes the agent on its own.
 *
 * ```ts
 * function Support() {
 *   const append = useAppendMessage();
 *   useTool({
 *     name: 'check_order',
 *     description: 'Look up the order and note anomalies for the model.',
 *     run: async ({ data }) => {
 *       const order = await lookupOrder(data.orderId);
 *       if (order.flagged) {
 *         append({ kind: 'signal', type: 'note', body: 'Order is fraud-flagged; do not promise a refund.' });
 *       }
 *       return order.summary;
 *     },
 *   });
 * }
 * ```
 *
 * Semantics:
 * - Accepts the same signal form `dispatch()` messages use
 *   (`{ kind: 'signal', type, body, attributes?, tagName? }`). `kind: 'user'`
 *   is rejected — a user message is real new input and belongs on
 *   `useDispatchMessage()`.
 * - Legal only while the agent is responding to a submission: from tool `run`
 *   functions, `useAgentStart`, and `useAgentFinish` callbacks. The writer
 *   throws during render and when the agent is idle.
 * - Appending during a `useAgentFinish` callback is the continuation signal:
 *   the response runs another turn instead of settling.
 */
export function useAppendMessage(): (message: AgentAppendMessage) => void {
	const frame = requireRenderFrame('useAppendMessage');
	if (frame.kind === 'subagent') {
		throw new Error(
			'[flue] useAppendMessage() is not available in a subagent render. A delegate has no running response of its own to annotate — return what it produced as its task result instead.',
		);
	}
	const channel = frame.state?.output;
	return (message) => {
		if (isRendering()) {
			throw new Error(
				'[flue] The useAppendMessage() writer was called during render. Renders are pure reads — append from tool run functions and lifecycle hook callbacks that run while the agent is responding.',
			);
		}
		if (!channel) {
			throw new Error(
				'[flue] useAppendMessage() has no durable runtime behind this render, so appends are unavailable.',
			);
		}
		channel.appendSignal(assertAppendMessage(message));
	};
}
