import type { SubagentDefinition } from '../types.ts';
import { requireRenderFrame } from './frame.ts';

/**
 * Declare a delegate the model can hand focused work to via the framework's
 * `task` tool. The `agent` function defines the delegate's whole world — it
 * is rendered at delegation time, in its own frame, fresh per task — and the
 * delegate is isolated from the parent: nothing flows in except the shared
 * environment and, unless overridden here, the parent's model and reasoning
 * effort. The delegate runs a detached session and only its final text
 * returns to the parent.
 *
 * ```ts
 * function Reproducer() {
 *   useSkill(reproduceSkill);
 *   return 'You reproduce one issue. Write your findings to report.md.';
 * }
 *
 * function ReproducePhase() {
 *   useSubagent({
 *     name: 'reproducer',
 *     description: 'Sets up the reproduction for one issue and writes report.md.',
 *     agent: Reproducer,
 *   });
 *   return 'Delegate the reproduction to the `reproducer` subagent.';
 * }
 * ```
 *
 * `name` + `description` are the delegate's catalog identity on the `task`
 * tool — the description is how the model decides when to delegate. Inside
 * the delegate's render, `useTool()`, `useInstruction()`, `useSkill()`,
 * custom hooks, and nested `useSubagent()` all compose as usual;
 * `usePersistentState()` and `useSandbox()` throw (durable state is instance-scoped
 * and delegates share the parent environment). Duplicate delegate names in
 * one render fail fast.
 */
export function useSubagent(subagent: SubagentDefinition): void {
	const frame = requireRenderFrame('useSubagent');
	if (!subagent || typeof subagent !== 'object' || Array.isArray(subagent)) {
		throw new Error(
			'[flue] useSubagent() requires an options object: { name, description, agent }.',
		);
	}
	const { name, description, agent, model, thinkingLevel } = subagent as Partial<SubagentDefinition>;
	if (typeof name !== 'string' || name.trim().length === 0) {
		throw new Error('[flue] useSubagent() name must be a non-empty string.');
	}
	if (typeof description !== 'string' || description.trim().length === 0) {
		throw new Error(
			`[flue] useSubagent() "${name}" needs a non-empty description — it is the catalog line the model uses to decide when to delegate.`,
		);
	}
	if (typeof agent !== 'function') {
		throw new Error(
			`[flue] useSubagent() "${name}" needs \`agent\`: the agent function that defines the delegate (rendered when the model delegates to it).`,
		);
	}
	if (model !== undefined && (typeof model !== 'string' || model.trim().length === 0)) {
		throw new Error(`[flue] useSubagent() "${name}" model must be a non-empty string.`);
	}
	if (frame.subagents.some((declared) => declared.name === name)) {
		throw new Error(
			`[flue] useSubagent() declared the subagent name "${name}" twice in one render. Each delegate declares once; share it from a single custom hook.`,
		);
	}
	frame.subagents.push({
		name,
		description,
		agent,
		...(model !== undefined ? { model } : {}),
		...(thinkingLevel !== undefined ? { thinkingLevel } : {}),
	});
}
