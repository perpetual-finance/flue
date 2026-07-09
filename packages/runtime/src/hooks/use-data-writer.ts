import * as v from 'valibot';
import { isRendering, requireRenderFrame } from './frame.ts';

/**
 * Declare a named, client-facing data part and get back a write-only
 * function that streams it.
 *
 * Output is one-way and non-reactive: the model never sees data parts, writes
 * never re-run the agent, and nothing is ever read back — the hook returns
 * only a writer (name the binding `write<Name>Data`). Mounting
 * emits nothing; the part exists only once it is first written. Each write is
 * appended durably and streamed to clients immediately, so a part can show
 * live progress mid-tool-run. The `name` is the part's identity within the
 * response: the first write places the part (AI SDK convention —
 * `data-<name>` in the response message's parts), and later writes update it
 * in place.
 *
 * ```ts
 * function useCaseContext() {
 *   const writeCaseCardData = useDataWriter({
 *     name: 'caseCard',
 *     schema: v.object({ caseId: v.string(), status: v.picklist(['loading', 'loaded']) }),
 *   });
 *   useTool({
 *     name: 'load_case',
 *     description: 'Load the case and stream a live card to the operator.',
 *     input: v.object({ caseId: v.string() }),
 *     run: async ({ data }) => {
 *       writeCaseCardData({ caseId: data.caseId, status: 'loading' });
 *       const found = await fetchCase(data.caseId);
 *       writeCaseCardData({ caseId: data.caseId, status: 'loaded' });
 *       return found.summary;
 *     },
 *   });
 * }
 * ```
 *
 * Semantics:
 * - Values are JSON: writes are normalized through a JSON round-trip and
 *   throw on non-serializable input; `schema` (when given) validates first.
 * - Writes are legal only while the agent is responding to a tracked
 *   submission — from tool `run` functions and other callbacks that run
 *   during one. The writer throws during render.
 * - Names are unique per render and part of the render's structural identity
 *   (never mount `useDataWriter` conditionally).
 */
export function useDataWriter<TSchema extends v.GenericSchema>(options: {
	name: string;
	schema: TSchema;
}): (data: v.InferOutput<TSchema>) => void;
export function useDataWriter(options: { name: string }): (data: unknown) => void;
export function useDataWriter(options: {
	name: string;
	schema?: v.GenericSchema;
}): (data: unknown) => void {
	const frame = requireRenderFrame('useDataWriter');
	if (frame.kind === 'subagent') {
		throw new Error(
			"[flue] useDataWriter() is not available in a subagent render. Data parts stream to the agent's public conversation; delegates run detached tasks with no client-facing output. Return what the delegate produced as its task result instead.",
		);
	}
	const { name, schema } = assertUseDataWriterOptions(options);
	if (frame.messageDataNames.has(name)) {
		throw new Error(
			`[flue] Duplicate useDataWriter name "${name}" in one render. Data part names identify a part within the response and must be unique.`,
		);
	}
	frame.messageDataNames.add(name);

	const channel = frame.state?.output;
	return (data: unknown) => {
		if (isRendering()) {
			throw new Error(
				`[flue] Message data "${name}" was written during render. Renders are pure reads — write from tool run functions and other callbacks that run while the agent is responding.`,
			);
		}
		if (!channel) {
			throw new Error(
				`[flue] Message data "${name}" has no durable runtime behind this render, so writes are unavailable.`,
			);
		}
		if (schema) {
			const parsed = v.safeParse(schema, data);
			if (!parsed.success) {
				throw new Error(
					`[flue] Message data "${name}" write does not match its schema: ${formatIssues(parsed.issues)}.`,
				);
			}
			data = parsed.output;
		}
		channel.writeMessageData(name, normalizeMessageData(name, data));
	};
}

const UseDataWriterOptionsSchema = v.strictObject(
	{
		name: v.pipe(v.string(), v.minLength(1)),
		schema: v.optional(v.custom<v.GenericSchema>(looksLikeSchema)),
	},
	(issue) =>
		issue.expected === 'never'
			? `received unknown useDataWriter option ${issue.received}`
			: issue.message,
);

function assertUseDataWriterOptions(options: unknown): { name: string; schema?: v.GenericSchema } {
	const parsed = v.safeParse(UseDataWriterOptionsSchema, options);
	if (!parsed.success) {
		throw new Error(`[flue] useDataWriter() options are invalid: ${formatIssues(parsed.issues)}.`);
	}
	const { name, schema } = parsed.output;
	return { name, ...(schema ? { schema } : {}) };
}

function looksLikeSchema(value: unknown): boolean {
	return (
		typeof value === 'object' &&
		value !== null &&
		(value as { kind?: unknown }).kind === 'schema' &&
		(value as { async?: unknown }).async === false
	);
}

function normalizeMessageData(name: string, data: unknown): unknown {
	if (data === undefined) {
		throw new Error(
			`[flue] Message data "${name}" cannot be written as undefined. Data parts are JSON values.`,
		);
	}
	let text: string | undefined;
	try {
		text = JSON.stringify(data);
	} catch (error) {
		throw new Error(
			`[flue] Message data "${name}" value is not JSON-serializable: ${error instanceof Error ? error.message : String(error)}.`,
		);
	}
	if (text === undefined) {
		throw new Error(`[flue] Message data "${name}" value is not JSON-serializable.`);
	}
	return JSON.parse(text);
}

function formatIssues(issues: readonly { message: string }[]): string {
	return issues.map((issue) => issue.message).join('; ');
}
