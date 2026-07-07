import * as v from 'valibot';
import type { AgentSignalAppend } from '../message-output.ts';
import { isRendering, requireRenderFrame } from './frame.ts';

/**
 * Get a write-only function that appends a signal to the current agent's
 * conversation history. Signals are the same first-class records a
 * `kind: 'signal'` dispatch delivers — rendered to the model as a
 * `<signal type="...">` tag — but an append is authored by *code* mid-run: it
 * annotates the running conversation and never wakes the agent.
 *
 * The hook takes no arguments and the writer is unbound — it can append any
 * signal (name the binding `append`; per-type conveniences are a userland
 * closure away). This completes the model-side write quadrant: `useDelivery`
 * reads what arrived, `useAppend` writes what code adds; `useMessageData` /
 * `useMessageMetadata` write to the client instead.
 *
 * ```ts
 * export default function IssueTriage() {
 *   const append = useAppend();
 *
 *   useTool({
 *     name: 'run_intake',
 *     description: 'Load the issue and decide whether triage is warranted.',
 *     harness: true,
 *     run: async ({ harness }) => {
 *       const issue = await loadIssue(harness);
 *       append({
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
 * Semantics:
 * - Appends are legal only during an active submission — from tool `run`
 *   functions and other callbacks that run while the agent is responding.
 *   The writer throws during render (renders are pure reads) and when the
 *   agent is idle (an appended signal is history annotation, never a
 *   delivery — to send input to an idle agent, use `dispatch()`).
 * - Appends are durable and ordered; the model sees them at the next turn
 *   boundary of the current run (or, when the run has already ended, at the
 *   start of the next one).
 * - `tagName` becomes the signal's XML envelope in model context and must be
 *   a valid XML tag name; `body` and `attributes` are escaped.
 * - Mounting attaches nothing and carries no durable identity — the hook can
 *   be called anywhere in the render, any number of times.
 */
export function useAppend(): (signal: AgentSignalAppend) => void {
	const frame = requireRenderFrame('useAppend');
	if (frame.kind === 'subagent') {
		throw new Error(
			"[flue] useAppend() is not available in a subagent render. Appended signals join the root agent's conversation history; a delegate runs a detached task — return what it produced as its task result instead.",
		);
	}
	const channel = frame.state?.output;
	return (signal: AgentSignalAppend) => {
		if (isRendering()) {
			throw new Error(
				'[flue] append() was called during render. Renders are pure reads — append from tool run functions and other callbacks that run while the agent is responding.',
			);
		}
		if (!channel) {
			throw new Error(
				'[flue] append() has no durable runtime behind this render, so signal appends are unavailable.',
			);
		}
		channel.appendSignal(assertSignalAppend(signal));
	};
}

const SignalAppendSchema = v.strictObject(
	{
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

function assertSignalAppend(signal: unknown): AgentSignalAppend {
	const parsed = v.safeParse(SignalAppendSchema, signal);
	if (!parsed.success) {
		throw new Error(
			`[flue] append() signal is invalid: ${parsed.issues.map((issue) => issue.message).join('; ')}.`,
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
