import type { DeliveredMessage } from '../types.ts';
import { requireRenderFrame } from './frame.ts';

/**
 * Read the delivered message that triggered the current run — the same
 * validated `DeliveredMessage` a `dispatch()` call or a direct HTTP prompt
 * admitted, verbatim. This is exactly what the model sees as the run's input
 * (a `kind: 'user'` message, or a `kind: 'signal'` rendered as a signal tag);
 * the hook gives *code* the same access, so tools no longer depend on the
 * model echoing values back into their input.
 *
 * ```ts
 * // dispatch(triage, { id: `issue-${n}`, message: { kind: 'signal',
 * //   type: 'issue.triage', body: '...', attributes: { issue: String(n) } } })
 * export default function IssueTriage() {
 *   const delivery = useDelivery();
 *   const issue =
 *     delivery.kind === 'signal' ? Number(delivery.attributes?.issue) : undefined;
 *
 *   useTool({
 *     name: 'load_issue',
 *     description: 'Fetch the GitHub issue named by the dispatch. Call this first.',
 *     run: async () => loadIssueDigest(issue),
 *   });
 * }
 * ```
 *
 * Semantics:
 * - Transport-agnostic: a direct API call and a `dispatch()` call carry the
 *   same wire shape and produce the same value here — including signals with
 *   `attributes` sent directly over HTTP.
 * - Constant across every render of one run (render-per-turn re-renders read
 *   the same triggering input; a new delivery starts a new run).
 * - In a subagent render, the delivery is the parent's task prompt as a
 *   `kind: 'user'` message (task images ride as `attachments`) — a delegate
 *   reads its triggering input exactly like a root agent reads its dispatch.
 * - Always present: every agent run is triggered by a delivered message, so
 *   the return is non-optional. A render with no delivery behind it (a bare
 *   tooling/test render outside the runtime) throws — supply one through the
 *   render-state context there.
 */
export function useDelivery(): DeliveredMessage {
	const frame = requireRenderFrame('useDelivery');
	const delivery = frame.state?.delivery;
	if (!delivery) {
		throw new Error(
			'[flue] useDelivery() found no delivered message behind this render. Every agent run in the runtime is triggered by one; a direct render outside the runtime (tests, tooling) must supply a `delivery` in its render-state context.',
		);
	}
	return delivery;
}
