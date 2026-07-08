import type { AgentStartContext } from '../message-output.ts';
import { requireRenderFrame } from './frame.ts';

/**
 * Run a callback when the agent starts work on a delivered message — after
 * the input is durable, before the model's first turn. The intake seam: load
 * what the model should wake up knowing, seed files, write durable state, and
 * announce it with a signal from `useAppendMessage()` so the model reads it
 * ahead of its first response.
 *
 * ```ts
 * export default function IssueTriage() {
 *   const append = useAppendMessage();
 *   const [issue, setIssue] = useState<Issue | null>('issue', null);
 *
 *   useAgentStart(async ({ harness, log }) => {
 *     const loaded = await loadIssue(issueNumber);
 *     await harness.fs.writeFile(`triage/gh-${loaded.number}/issue.md`, digest(loaded));
 *     setIssue(loaded);
 *     log.info('issue loaded', { issue: loaded.number });
 *     append({ kind: 'signal', type: 'intake', body: `Issue #${loaded.number} loaded.` });
 *   });
 * }
 * ```
 *
 * Semantics:
 * - Runs once per delivered submission, before turn 1 — every delivery, in
 *   declaration order, sequentially. Not reactive: nothing watches anything,
 *   and callbacks never re-run mid-response. For work that should happen only
 *   once in the instance's lifetime, guard with durable state
 *   (`if (loaded) return`).
 * - `run` may be async and is awaited; a throw fails the submission before
 *   the model runs. All output is explicit: signals via `useAppendMessage()`,
 *   durable values via state setters, files via the harness.
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
