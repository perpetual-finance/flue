import * as v from 'valibot';
import { ToolNameConflictError } from '../errors.ts';
import type { AgentFunction, AgentManifest, AgentRuntimeConfig } from '../types.ts';
import { type ComponentRecord, type RenderFrame, renderWithFrame } from './frame.ts';

const AgentManifestSchema = v.strictObject(
	{
		model: v.optional(v.string()),
		instruction: v.optional(v.string()),
		thinkingLevel: v.optional(v.string()),
		compaction: v.optional(v.union([v.literal(false), v.looseObject({})])),
		durability: v.optional(v.looseObject({})),
		cwd: v.optional(v.string()),
	},
	(issue) =>
		issue.expected === 'never'
			? `received unknown agent manifest field ${issue.received}`
			: issue.message,
);

/**
 * Run one render of an agent function: invoke it inside a fresh frame,
 * validate the returned manifest, and map manifest + hook attachments onto
 * the internal runtime-config shape the initialization path consumes (the
 * same shape a `defineAgent` initializer returns). Field values beyond shape
 * (thinking levels, compaction/durability fields) are validated downstream by
 * the shared profile asserts, exactly as for `defineAgent`.
 */
export function renderAgentFunction(fn: AgentFunction): AgentRuntimeConfig {
	const { result, frame } = renderWithFrame(fn);
	assertAgentManifest(result);
	assertUniqueToolNames(frame);
	const instructions = composeAgentDocument(result.instruction, frame);
	const tools = [...frame.root.tools, ...frame.components.flatMap((record) => record.tools)];
	return {
		...(result.model !== undefined ? { model: result.model } : {}),
		...(instructions !== undefined ? { instructions } : {}),
		...(tools.length > 0 ? { tools } : {}),
		...(result.thinkingLevel !== undefined ? { thinkingLevel: result.thinkingLevel } : {}),
		...(result.compaction !== undefined ? { compaction: result.compaction } : {}),
		...(result.durability !== undefined ? { durability: result.durability } : {}),
		...(result.cwd !== undefined ? { cwd: result.cwd } : {}),
	};
}

/**
 * The agent's instruction document: base instruction first, then ungrouped
 * `useInstruction` contributions in call order, then one uniform section per
 * mounted component under a Capabilities heading. The exact formatting is
 * internal and expected to iterate; the ordering above is the contract.
 */
function composeAgentDocument(base: string | undefined, frame: RenderFrame): string | undefined {
	const parts = [
		...(base !== undefined ? [base] : []),
		...frame.root.instructions,
		...(frame.components.length > 0 ? [renderCapabilities(frame.components)] : []),
	];
	if (parts.length === 0) return undefined;
	return parts.join('\n\n');
}

function renderCapabilities(components: readonly ComponentRecord[]): string {
	const sections = components.map((record) => {
		const lines = [
			`## ${record.key}`,
			...(record.description !== undefined ? [record.description] : []),
			...(record.instruction !== undefined ? [record.instruction] : []),
			...record.instructions,
			...(record.tools.length > 0
				? [`Tools: ${record.tools.map((tool) => tool.name).join(', ')}`]
				: []),
		];
		return lines.join('\n');
	});
	return [
		'# Capabilities',
		'You have the following capabilities. Each lists its guidance and the tools it provides.',
		...sections,
	].join('\n\n');
}

function assertUniqueToolNames(frame: RenderFrame): void {
	const seen = new Set<string>();
	const all = [...frame.root.tools, ...frame.components.flatMap((record) => record.tools)];
	for (const tool of all) {
		if (seen.has(tool.name)) {
			throw new ToolNameConflictError({ name: tool.name, conflict: 'duplicate', source: 'custom' });
		}
		seen.add(tool.name);
	}
}

function assertAgentManifest(value: unknown): asserts value is AgentManifest {
	if (typeof value === 'string') {
		throw new Error(
			'[flue] Agent functions must return a manifest object ({ model, instruction, ... }); returning a string is not supported.',
		);
	}
	if (isPromiseLike(value)) {
		throw new Error(
			'[flue] Agent functions must be synchronous. Move async work into tools, actions, or resource factories.',
		);
	}
	if (!value || typeof value !== 'object' || Array.isArray(value)) {
		throw new Error(
			'[flue] Agent functions must return a manifest object ({ model, instruction, ... }).',
		);
	}
	const parsed = v.safeParse(AgentManifestSchema, value);
	if (!parsed.success) {
		throw new Error(
			`[flue] Agent function returned an invalid manifest: ${parsed.issues
				.map((issue) => issue.message)
				.join('; ')}.`,
		);
	}
}

export function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
	return (
		typeof value === 'object' &&
		value !== null &&
		'then' in value &&
		typeof (value as { then: unknown }).then === 'function'
	);
}
