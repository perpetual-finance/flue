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
	return renderAgentFunctionWithStructure(capability, config, state).config;
}

/**
 * The structural fingerprint of one render, for the invariance guard:
 * capabilities are compared by function identity in mount order; tools by
 * NAME only (schemas may legally vary with state — labels fetched at
 * runtime, say — without counting as a structural change); state by name;
 * the sandbox by presence (the environment is built once at initialization,
 * so only a conditional `useSandbox` counts as a structural change).
 */
export interface AgentRenderStructure {
	capabilities: readonly ((props?: never) => unknown)[];
	capabilityNames: readonly string[];
	toolNames: readonly string[];
	stateNames: readonly string[];
	hasSandbox: boolean;
}

/** `renderAgentFunction` plus the render's structural fingerprint. */
export function renderAgentFunctionWithStructure(
	capability: Capability,
	config: FunctionAgentConfig,
	state?: RenderStateContext,
): { config: AgentRuntimeConfig; structure: AgentRenderStructure } {
	const { result, frame } = renderWithFrame(capability, state);
	assertAgentInstruction(result);
	assertUniqueToolNames(frame);
	const instructions = composeAgentDocument(result, frame);
	const tools = [...frame.root.tools, ...frame.capabilities.flatMap((record) => record.tools)];
	return {
		config: {
			model: config.model,
			...(instructions !== undefined ? { instructions } : {}),
			...(tools.length > 0 ? { tools } : {}),
			...(config.thinkingLevel !== undefined ? { thinkingLevel: config.thinkingLevel } : {}),
			...(config.compaction !== undefined ? { compaction: config.compaction } : {}),
			...(config.durability !== undefined ? { durability: config.durability } : {}),
			...(config.cwd !== undefined ? { cwd: config.cwd } : {}),
			...(frame.sandbox !== undefined ? { sandbox: frame.sandbox } : {}),
		},
		structure: {
			capabilities: frame.capabilities.map((record) => record.capability),
			capabilityNames: frame.capabilities.map((record) => record.capability.name || '(anonymous)'),
			toolNames: tools.map((tool) => tool.name),
			stateNames: [...frame.stateNames],
			hasSandbox: frame.sandbox !== undefined,
		},
	};
}

/**
 * Renders must be structurally identical across an agent instance's life:
 * `use()` and hook calls are never conditional. State informs the agent
 * (values, props, guards, interpolated text) — it does not reshape it.
 * Throws with the precise delta when consecutive renders disagree.
 */
export function assertRenderStructureInvariance(
	previous: AgentRenderStructure,
	next: AgentRenderStructure,
): void {
	const problems: string[] = [];
	const sameCapabilities =
		previous.capabilities.length === next.capabilities.length &&
		previous.capabilities.every((fn, index) => fn === next.capabilities[index]);
	if (!sameCapabilities) {
		problems.push(
			`mounted capabilities changed (${previous.capabilityNames.join(', ') || 'none'} → ${next.capabilityNames.join(', ') || 'none'})`,
		);
	}
	const toolDelta = setDelta(previous.toolNames, next.toolNames);
	if (toolDelta) problems.push(`tools ${toolDelta}`);
	const stateDelta = setDelta(previous.stateNames, next.stateNames);
	if (stateDelta) problems.push(`state ${stateDelta}`);
	if (previous.hasSandbox !== next.hasSandbox) {
		problems.push(`sandbox ${next.hasSandbox ? 'added' : 'removed'}`);
	}
	if (problems.length > 0) {
		throw new Error(
			`[flue] The agent's render changed structure between turns: ${problems.join('; ')}. ` +
				'use() and hook calls must not be conditional — every render mounts the same capabilities, tools, and state. Drive behavior with state values, props, and tool guards instead.',
		);
	}
}

function setDelta(previous: readonly string[], next: readonly string[]): string | undefined {
	const before = new Set(previous);
	const after = new Set(next);
	const added = [...after].filter((name) => !before.has(name));
	const removed = [...before].filter((name) => !after.has(name));
	if (added.length === 0 && removed.length === 0) return undefined;
	return [
		...(added.length > 0 ? [`added ${added.join(', ')}`] : []),
		...(removed.length > 0 ? [`removed ${removed.join(', ')}`] : []),
	].join('; ');
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
