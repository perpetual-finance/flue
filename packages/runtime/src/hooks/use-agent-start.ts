import type { AgentStartContext } from '../message-output.ts';
import { requireRenderFrame } from './frame.ts';

/**
 * Run a callback when the agent starts work on a delivered message — after
 * the input is durable, before the model's first turn. The intake seam: load
 * what the model should wake up knowing, seed files, write durable state,
 * and announce it by dispatching a signal — the delivery joins this same
 * response, so the model reads it ahead of its first answer.
 *
 * ```ts
 * export default function IssueTriage() {
 *   const dispatch = useDispatchMessage();
 *   const [issue, setIssue] = usePersistentState<Issue | null>('issue', null);
 *
 *   useAgentStart(async ({ harness, log }) => {
 *     if (issue) return; // durable guard: intake happens once
 *     const loaded = await loadIssue(issueNumber);
 *     await harness.sandbox.writeFile(`triage/gh-${loaded.number}/issue.md`, digest(loaded));
 *     setIssue(loaded);
 *     log.info('issue loaded', { issue: loaded.number });
 *     await dispatch({ kind: 'signal', type: 'intake', body: `Issue #${loaded.number} loaded.` });
 *   });
 * }
 * ```
 *
 * Semantics:
 * - Runs once per delivered message, before the model reads it — every
 *   delivery, in declaration order, sequentially. That includes deliveries
 *   that JOIN a live response mid-run (dispatch-while-busy): when several
 *   messages collect into one response, the hooks run once per message,
 *   each after its input is durable and before the model's next turn. Not
 *   reactive: nothing watches anything, and callbacks never re-run for a
 *   message already dealt with. For work that should happen only once in
 *   the instance's lifetime, guard with durable state (`if (loaded) return`).
 * - `run` may be async and is awaited; a throw fails the submission before
 *   the model runs. All output is explicit: model-facing signals via the
 *   `useDispatchMessage()` dispatcher (each is a real delivery — it fires
 *   these hooks itself, so guard with durable state), durable values via
 *   state setters, files via the harness.
 * - Identity is call order. At-least-once: a run interrupted before its
 *   completion record re-runs on the re-attempt; a completed run is adopted,
 *   never repeated.
 * - Compaction note: keep the callback's substance where compaction cannot
 *   eat it — durable state and disk. A signal is the announcement, not the
 *   storage.
 */
export function useAgentStart(run: (ctx: AgentStartContext) => void | Promise<void>): void {
	const frame = requireRenderFrame('useAgentStart');
	if (frame.kind === 'subagent') {
		throw new Error(
			"[flue] useAgentStart() is not available in a subagent render. Lifecycle hooks run against the root agent's durable record log; a delegate runs a detached task — do its up-front work in the task itself.",
		);
	}
	if (typeof run !== 'function') {
		throw new Error('[flue] useAgentStart(run) takes a callback as its only argument.');
	}
	frame.agentStarts.push({ run });
}
