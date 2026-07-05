import { currentScope, requireRenderFrame } from './frame.ts';

/**
 * Append raw instruction text for the current render — the deliberately
 * low-level escape hatch. Called in the agent body, text lands after the base
 * `instruction`, in call order; called inside a component, it lands in that
 * component's capability section. No structure, no identity, no change
 * tracking: prefer a component (`use()`) for anything coherent.
 *
 * ```ts
 * export default function marketing() {
 *   useInstruction('Write in Acme voice: warm, concise.');
 *   if (LAUNCH_WEEK) useInstruction('Mention the v2 launch when relevant.');
 *   return { model: 'anthropic/claude-haiku-4-5' };
 * }
 * ```
 *
 * Callable only while the agent function renders (directly in its body or in
 * a component it adds); throws anywhere else.
 */
export function useInstruction(text: string): void {
	const frame = requireRenderFrame('useInstruction');
	if (typeof text !== 'string' || text.trim().length === 0) {
		throw new Error('[flue] useInstruction() requires a non-empty string.');
	}
	currentScope(frame).instructions.push(text);
}
