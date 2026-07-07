import type { EffectContext } from '../message-output.ts';
import { requireRenderFrame } from './frame.ts';

/**
 * Run a side effect at the start of a submission — after the delivered input
 * is durable, before the model's first turn — with a deps array as the whole
 * cadence contract. React's shape exactly: `useEffect(run, deps)`, identity
 * by call order, no name.
 *
 * ```ts
 * export default function IssueTriage() {
 *   const delivery = useDelivery();
 *   const append = useAppend();
 *
 *   useEffect(async ({ harness, log }) => {
 *     const issue = await loadIssue(deliveredIssueNumber(delivery));
 *     await harness.fs.writeFile(`triage/gh-${issue.number}/issue.md`, digest(issue));
 *     setIssue(issue);
 *     append({ type: 'intake', body: `Issue #${issue.number} loaded.` });
 *   }, [delivery]);
 * }
 * ```
 *
 * Deps decide how often the effect runs — the decision is always conscious
 * (deps are required):
 * - `[delivery]` — every delivered message.
 * - `[]` — once per agent instance lifetime.
 * - `[someState]` — when that durable value moved since the effect's last
 *   run, checked at message boundaries.
 *
 * Semantics (the React deltas, worth reading once):
 * - NOT reactive: effects are evaluated once per delivered submission, in
 *   declaration order, sequentially — never mid-run, and nothing watches
 *   anything. The deps array is a durable memo: the effect runs only when
 *   its deps fingerprint (JSON of the array, computed at render) differs
 *   from its last completed run in the record log. An effect that changes
 *   its own deps does not retrigger within the submission.
 * - `run` may be async and is awaited; it returns void — no cleanup
 *   function. All output is explicit: signals via `useAppend`, durable
 *   values via state setters, files via the harness. A throw fails the
 *   submission before the model runs.
 * - `run` receives a context argument — `{ harness, log, signal }` — so
 *   zero-argument React-style callbacks work unchanged. `harness` is the
 *   invocation-scoped runtime surface (sandbox shell/fs, child sessions for
 *   scoped model calls), materialized lazily on first access.
 * - Identity is call order. Across deploys, inserting or reordering effects
 *   shifts indices — append new effects after existing ones; expect at worst
 *   a one-time re-run (or, when a shifted effect's deps fingerprint happens
 *   to match the previous occupant's, a skip until its deps next change).
 * - At-least-once: a run interrupted before its completion record re-runs on
 *   the re-attempt; a completed run is adopted, never repeated.
 * - Compaction note: keep the effect's substance where compaction cannot eat
 *   it — durable state and disk. A signal is the announcement, not the
 *   storage.
 */
export function useEffect(
	run: (ctx: EffectContext) => void | Promise<void>,
	deps: readonly unknown[],
): void {
	const frame = requireRenderFrame('useEffect');
	if (frame.kind === 'subagent') {
		throw new Error(
			'[flue] useEffect() is not available in a subagent render. Effects run against the root agent\'s durable record log; a delegate runs a detached task — do its up-front work in the task itself.',
		);
	}
	if (typeof run !== 'function') {
		throw new Error(
			'[flue] useEffect(run, deps) takes the run callback as its first argument.',
		);
	}
	if (!Array.isArray(deps)) {
		throw new Error(
			'[flue] useEffect(run, deps) requires a deps array — it is the whole "how often" contract: [delivery] runs every message, [] once per instance, [someState] when that value moved since the last run.',
		);
	}
	frame.effects.push({ run, fingerprint: fingerprintDeps(deps, frame.effects.length) });
}

/**
 * The durable memo key: JSON of the deps array. Deps must be JSON data — the
 * values the effect reads — not closures or other by-reference identities,
 * which JSON would silently collapse and corrupt the memo.
 */
function fingerprintDeps(deps: readonly unknown[], index: number): string {
	for (const [depIndex, dep] of deps.entries()) {
		if (typeof dep === 'function' || typeof dep === 'symbol' || typeof dep === 'bigint') {
			throw new Error(
				`[flue] useEffect deps must be JSON values (deps[${depIndex}] of effect #${index} is a ${typeof dep}). Pass the data the effect reads — state values, delivery fields — not references.`,
			);
		}
	}
	try {
		return JSON.stringify(deps);
	} catch (error) {
		throw new Error(
			`[flue] useEffect deps for effect #${index} are not JSON-serializable: ${error instanceof Error ? error.message : String(error)}.`,
			{ cause: error },
		);
	}
}
