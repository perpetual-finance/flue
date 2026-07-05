import { ToolNameConflictError } from '../errors.ts';
import type { AgentRuntimeConfig, Capability, FunctionAgentConfig } from '../types.ts';
import {
	type CapabilityRecord,
	type RenderFrame,
	type RenderStateContext,
	renderWithFrame,
} from './frame.ts';

/**
 * Run one render of an agent's capability function: invoke it inside a fresh
 * frame, validate the returned instruction, and map the static config + hook
 * attachments onto the internal runtime-config shape the initialization path
 * consumes (the same shape a legacy `defineAgent` initializer returns).
 * Config field values beyond shape (thinking levels, compaction/durability
 * fields) are validated downstream by the shared profile asserts.
 */
export function renderAgentFunction(
	capability: Capability,
	config: FunctionAgentConfig,
	state?: RenderStateContext,
): AgentRuntimeConfig {
	const { result, frame } = renderWithFrame(capability, state);
	assertAgentInstruction(result);
	assertUniqueToolNames(frame);
	const instructions = composeAgentDocument(result, frame);
	const tools = [...frame.root.tools, ...frame.capabilities.flatMap((record) => record.tools)];
	return {
		model: config.model,
		...(instructions !== undefined ? { instructions } : {}),
		...(tools.length > 0 ? { tools } : {}),
		...(config.thinkingLevel !== undefined ? { thinkingLevel: config.thinkingLevel } : {}),
		...(config.compaction !== undefined ? { compaction: config.compaction } : {}),
		...(config.durability !== undefined ? { durability: config.durability } : {}),
		...(config.cwd !== undefined ? { cwd: config.cwd } : {}),
	};
}

/**
 * The agent's instruction document, concatenated in composition order: the
 * agent's returned instruction first, then root-level `useInstruction`
 * contributions in call order, then each mounted capability's content (its
 * returned instruction, then its in-body contributions) in mount order.
 * Authors own all formatting — the runtime only joins with blank lines.
 */
function composeAgentDocument(base: string | undefined, frame: RenderFrame): string | undefined {
	const parts = [
		...(base !== undefined && base.length > 0 ? [base] : []),
		...frame.root.instructions,
		...frame.capabilities.flatMap(capabilityParts),
	];
	if (parts.length === 0) return undefined;
	return parts.join('\n\n');
}

function capabilityParts(record: CapabilityRecord): string[] {
	return [
		...(record.instruction !== undefined ? [record.instruction] : []),
		...record.instructions,
	];
}

function assertUniqueToolNames(frame: RenderFrame): void {
	const seen = new Set<string>();
	const all = [...frame.root.tools, ...frame.capabilities.flatMap((record) => record.tools)];
	for (const tool of all) {
		if (seen.has(tool.name)) {
			throw new ToolNameConflictError({ name: tool.name, conflict: 'duplicate', source: 'custom' });
		}
		seen.add(tool.name);
	}
}

function assertAgentInstruction(value: unknown): asserts value is string | undefined {
	if (isPromiseLike(value)) {
		throw new Error(
			'[flue] Agent capability functions must be synchronous. Move async work into tools, actions, or resource factories.',
		);
	}
	if (value !== undefined && typeof value !== 'string') {
		throw new Error(
			'[flue] An agent returns its instruction string (or nothing). Model and settings belong in defineAgent(Agent, { model, ... }); everything else is composed with hooks in the body.',
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
