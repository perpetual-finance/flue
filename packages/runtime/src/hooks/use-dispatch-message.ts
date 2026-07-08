import { enqueueDispatch } from '../runtime/dispatch.ts';
import { getFlueRuntime } from '../runtime/flue-app.ts';
import type { DeliveredMessage, DispatchReceipt } from '../types.ts';
import { isRendering, requireRenderFrame } from './frame.ts';

/**
 * Get a dispatcher bound to this agent instance — the agent-scoped form of
 * the global `dispatch()`, the way a router hook overloads a browser
 * primitive with the router-scoped version. The returned function takes just
 * the message: the instance already exists, so there is no creation `data`
 * (that is initial data) and no `uid` condition to pass.
 *
 * ```ts
 * export default function IssueTriage() {
 *   const dispatch = useDispatchMessage();
 *
 *   useTool({
 *     name: 'run_intake',
 *     description: 'Load the issue and decide whether triage is warranted.',
 *     harness: true,
 *     run: async ({ harness }) => {
 *       const issue = await loadIssue(harness);
 *       await dispatch({
 *         kind: 'signal',
 *         type: 'intake',
 *         body: `Issue #${issue.number} loaded; triage warranted.`,
 *         attributes: { issue: String(issue.number) },
 *       });
 *       return 'Intake complete.';
 *     },
 *   });
 * }
 * ```
 *
 * Semantics — identical to the global `dispatch()` by construction (same
 * queue, same admission, same delivery):
 * - Mid-run, the message joins the current conversation at the next turn
 *   boundary; when the agent is idle, it wakes a new submission — a late
 *   callback dispatching after the run settled behaves exactly like an
 *   external sender.
 * - Both message kinds work: a `signal` annotates the conversation; a `user`
 *   message queues a real follow-up turn.
 * - Each call is a durable submission with its own receipt. Like any
 *   external side effect in a re-attempted tool, a re-run dispatches again —
 *   design for at-least-once.
 * - The dispatcher throws during render (renders are pure reads) and on bare
 *   tooling/test renders with no runtime behind them.
 * - For a durable signal ordered into the CURRENT submission before the
 *   model's first turn — the intake pattern — use an effect's `append`
 *   instead: it rides the effect's atomic outcome batch.
 */
export function useDispatchMessage(): (message: DeliveredMessage) => Promise<DispatchReceipt> {
	const frame = requireRenderFrame('useDispatchMessage');
	if (frame.kind === 'subagent') {
		throw new Error(
			'[flue] useDispatchMessage() is not available in a subagent render. A delegate has no instance of its own to dispatch to — return what it produced as its task result instead.',
		);
	}
	const agentName = frame.state?.agentName;
	const instanceId = frame.state?.instanceId;
	return async (message: DeliveredMessage): Promise<DispatchReceipt> => {
		if (isRendering()) {
			throw new Error(
				'[flue] The useDispatchMessage() dispatcher was called during render. Renders are pure reads — dispatch from tool run functions, effects, and other callbacks.',
			);
		}
		if (agentName === undefined || instanceId === undefined) {
			throw new Error(
				'[flue] The useDispatchMessage() dispatcher has no durable runtime behind this render, so self-dispatch is unavailable.',
			);
		}
		const rt = getFlueRuntime();
		if (!rt) {
			throw new Error(
				'[flue] The useDispatchMessage() dispatcher was called before the Flue runtime was configured. This usually means the agent is running outside a Flue-built server entry.',
			);
		}
		return enqueueDispatch({
			request: { agent: agentName, id: instanceId, message },
			dispatchQueue: rt.dispatchQueue,
			rt,
		});
	};
}
