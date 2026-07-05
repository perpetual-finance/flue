import { assertToolDefinition } from '../tool.ts';
import type { ToolDefinition, ToolInputSchema, ToolOutputSchema } from '../tool-types.ts';
import { currentScope, requireRenderFrame } from './frame.ts';

/**
 * Mount a model-callable tool for the current render.
 *
 * Accepts a `defineTool(...)` value or an inline definition object (same
 * validation, applied here; `run`'s input is typed from the `input` schema).
 * Called directly in the agent body or inside a capability — either way the
 * tool joins the render's single flat tool set:
 *
 * ```ts
 * function Retention() {
 *   useTool(offerCredit);
 *   return 'You may offer retention incentives.';
 * }
 * ```
 *
 * Duplicate active tool names across the whole render fail fast.
 */
export function useTool<
	const TInput extends ToolInputSchema | undefined = undefined,
	const TOutput extends ToolOutputSchema | undefined = undefined,
>(tool: {
	name: string;
	description: string;
	input?: TInput;
	output?: TOutput;
	run: ToolDefinition<TInput, TOutput>['run'];
}): void {
	const frame = requireRenderFrame('useTool');
	assertToolDefinition(tool, 'useTool()');
	currentScope(frame).tools.push(tool as unknown as ToolDefinition);
}
