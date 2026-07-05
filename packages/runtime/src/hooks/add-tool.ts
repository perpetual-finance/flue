import type { ToolDefinition, ToolInputSchema, ToolOutputSchema } from '../tool-types.ts';
import { assertToolDefinition } from '../tool.ts';
import { currentScope, requireRenderFrame } from './frame.ts';

/**
 * Mount a model-callable tool for the current render.
 *
 * Accepts a `defineTool(...)` value or an inline definition object (same
 * validation, applied here; `run`'s input is typed from the `input` schema).
 * Called directly in the agent body the tool is ungrouped; called inside a
 * component it belongs to that component's capability section:
 *
 * ```ts
 * function RetentionIncentives() {
 *   addTool(offerCredit);
 *   return { key: 'retention', instruction: 'You may offer retention incentives.' };
 * }
 * ```
 *
 * Duplicate active tool names across the whole render fail fast.
 */
export function addTool<
	const TInput extends ToolInputSchema | undefined = undefined,
	const TOutput extends ToolOutputSchema | undefined = undefined,
>(tool: {
	name: string;
	description: string;
	input?: TInput;
	output?: TOutput;
	run: ToolDefinition<TInput, TOutput>['run'];
}): void {
	const frame = requireRenderFrame('addTool');
	assertToolDefinition(tool, 'addTool()');
	currentScope(frame).tools.push(tool as unknown as ToolDefinition);
}
