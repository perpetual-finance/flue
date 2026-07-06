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
 *     delivery?.kind === 'signal' ? Number(delivery.attributes?.issue) : undefined;
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
 * - Returns `undefined` when no delivered message triggered the run —
 *   guard for it, or make the model-facing contract require one.
 * - Throws in subagent renders: delegates receive their world through the
 *   task prompt, not the parent's input.
 */
export function useDelivery(): DeliveredMessage | undefined {
	const frame = requireRenderFrame('useDelivery');
	if (frame.kind === 'subagent') {
		throw new Error(
			'[flue] useDelivery() is not available in a subagent render. Delegates run detached tasks with no delivery of their own; pass what the delegate needs through the task prompt instead.',
		);
	}
	return frame.state?.delivery;
}
