import type * as v from 'valibot';
import type { JsonValue } from './json-snapshot.ts';
import type { FlueHarness, FlueLogger } from './types.ts';

export type ToolInputSchema = v.GenericSchema<Record<string, unknown>, unknown>;
export type ToolOutputSchema = v.GenericSchema<any, NonNullable<unknown> | null>;

/**
 * The context passed to a tool's `run`. Every tool gets `log` (streamed into
 * the conversation as progress events) and the tool call's `signal`. Flags on
 * the definition extend it: an `input` schema adds `data` — the call's
 * arguments, parsed by that schema; `harness: true` adds `harness` — the
 * agent's runtime surface (sandbox `shell`/`fs`, sessions, model calls).
 * Tools without `harness` are pure functions of their data.
 */
export type ToolContext<
	S extends ToolInputSchema | undefined,
	H extends boolean | undefined = undefined,
> = {
	readonly signal?: AbortSignal;
	/**
	 * Progress logging for long-running tools. Lines are emitted into the
	 * conversation stream as `log` events attributed to this tool call — they
	 * are not part of the tool result and the model never sees them.
	 */
	readonly log: FlueLogger;
} & (S extends ToolInputSchema ? { readonly data: v.InferOutput<S> } : Record<never, never>) &
	// Non-distributive on purpose: for the default `boolean | undefined` the
	// harness property is absent, so generic ToolDefinition consumers see the
	// base context.
	([H] extends [true] ? { readonly harness: FlueHarness } : Record<never, never>);

type ToolRunResult<S extends ToolOutputSchema | undefined> = S extends ToolOutputSchema
	? v.InferInput<S>
	: JsonValue | undefined;

export interface ToolDefinition<
	TInput extends ToolInputSchema | undefined = ToolInputSchema | undefined,
	TOutput extends ToolOutputSchema | undefined = ToolOutputSchema | undefined,
	THarness extends boolean | undefined = boolean | undefined,
> {
	readonly name: string;
	readonly description: string;
	readonly input: TInput;
	readonly output: TOutput;
	/**
	 * Connect this tool to the agent's runtime: `run` receives `harness`,
	 * the one interface to the sandbox (`harness.shell()`, `harness.fs`) and
	 * to models (`harness.prompt()` / `skill()` / `task()`). Harness
	 * invocations are scoped to the tool call, count against the
	 * delegation-depth cap, and retain any child conversations they open.
	 * Harness tools only run inside an agent session — never standalone.
	 */
	readonly harness?: THarness;
	run(
		context: ToolContext<TInput, THarness>,
	): ToolRunResult<TOutput> | Promise<ToolRunResult<TOutput>>;
}

export type ToolInput<TTool extends ToolDefinition> = TTool extends ToolDefinition<
	infer TInput,
	any,
	any
>
	? TInput extends ToolInputSchema
		? v.InferInput<TInput>
		: never
	: never;

export type ToolOutput<TTool extends ToolDefinition> = TTool extends ToolDefinition<
	any,
	infer TOutput,
	any
>
	? TOutput extends ToolOutputSchema
		? v.InferOutput<TOutput>
		: unknown
	: never;
