import type * as v from 'valibot';
import type { JsonValue } from './json-snapshot.ts';
import type { FlueFs, ShellResult } from './types.ts';

export type ToolInputSchema = v.GenericSchema<Record<string, unknown>, unknown>;
export type ToolOutputSchema = v.GenericSchema<any, NonNullable<unknown> | null>;

/**
 * Options for {@link ToolContext.shell}. The tool call's own `AbortSignal` is
 * composed in by the runtime — aborting the tool run aborts the command — so
 * there is no `signal` option here.
 */
export interface ToolShellOptions {
	/** Environment variables supplied to the command. */
	env?: Record<string, string>;
	/** Working directory supplied to the command. */
	cwd?: string;
	/** Wall-clock deadline in milliseconds. See `SessionEnv.exec`. */
	timeoutMs?: number;
}

export type ToolContext<S extends ToolInputSchema | undefined> = {
	readonly signal?: AbortSignal;
	/**
	 * Run a shell command in the agent's environment (the sandbox attached
	 * with `useSandbox`, cwd-scoped). Not recorded in the conversation — the
	 * tool's own result is the record. Returns the full {@link ShellResult};
	 * check `exitCode` yourself. Sandboxes without command execution (codemode
	 * adapters, say) throw their exec error here, same as `session.shell()`.
	 */
	readonly shell: (command: string, options?: ToolShellOptions) => Promise<ShellResult>;
	/** Read and write files in the agent's environment. See {@link FlueFs}. */
	readonly fs: FlueFs;
} & (S extends ToolInputSchema
	? { readonly input: v.InferOutput<S> }
	: Record<never, never>);

type ToolRunResult<S extends ToolOutputSchema | undefined> = S extends ToolOutputSchema
	? v.InferInput<S>
	: JsonValue | undefined;

export interface ToolDefinition<
	TInput extends ToolInputSchema | undefined = ToolInputSchema | undefined,
	TOutput extends ToolOutputSchema | undefined = ToolOutputSchema | undefined,
> {
	readonly name: string;
	readonly description: string;
	readonly input: TInput;
	readonly output: TOutput;
	run(context: ToolContext<TInput>): ToolRunResult<TOutput> | Promise<ToolRunResult<TOutput>>;
}

export type ToolInput<TTool extends ToolDefinition> = TTool extends ToolDefinition<
	infer TInput,
	any
>
	? TInput extends ToolInputSchema
		? v.InferInput<TInput>
		: never
	: never;

export type ToolOutput<TTool extends ToolDefinition> = TTool extends ToolDefinition<
	any,
	infer TOutput
>
	? TOutput extends ToolOutputSchema
		? v.InferOutput<TOutput>
		: unknown
	: never;
