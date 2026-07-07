import { ToolNameConflictError } from '../errors.ts';
import type {
	AgentProfile,
	AgentProps,
	AgentRuntimeConfig,
	Capability,
	DeliveredMessage,
	FunctionAgentConfig,
	SubagentDefinition,
} from '../types.ts';
import {
	type CapabilityRecord,
	type RenderFrame,
	type RenderStateContext,
	renderWithFrame,
} from './frame.ts';

/**
 * The props the runtime passes to the ROOT capability. On a bare render with
 * no backing instance (tests/tooling), reading `id` throws — the same
 * contract as `useDelivery()` on an unbacked render. Subagent capabilities
 * never receive props: a delegate runs in isolation from the parent.
 */
function agentPropsFor(state: RenderStateContext | undefined): AgentProps {
	if (state?.instanceId !== undefined) return { id: state.instanceId };
	const props = {};
	Object.defineProperty(props, 'id', {
		get(): string {
			throw new Error(
				'[flue] This render has no agent instance behind it, so `props.id` is unavailable. Pass `instanceId` in the render state to back it in tests and tooling.',
			);
		},
	});
	return props as AgentProps;
}

/**
 * Run one render of an agent's capability function: invoke it inside a fresh
 * frame, validate the returned instruction, and map the static config + hook
 * attachments onto the internal runtime-config shape the initialization path
 * consumes (the same shape a legacy `defineAgent` initializer returns).
 * Config field values beyond shape (thinking levels, compaction/durability
 * fields) are validated downstream by the shared profile asserts.
 */
export function renderAgentFunction(
	capability: Capability<AgentProps>,
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
	messageDataNames: readonly string[];
	skillNames: readonly string[];
	subagentNames: readonly string[];
	hasSandbox: boolean;
	/**
	 * `useEffect` declarations this render. Effects have no names — identity
	 * is call order — so the count (with the rules of hooks) pins the order.
	 */
	effectCount: number;
}

/** `renderAgentFunction` plus the render's structural fingerprint. */
export function renderAgentFunctionWithStructure(
	capability: Capability<AgentProps>,
	config: FunctionAgentConfig,
	state?: RenderStateContext,
): { config: AgentRuntimeConfig; structure: AgentRenderStructure } {
	const props = agentPropsFor(state);
	const { result, frame } = renderWithFrame(() => capability(props), state);
	assertAgentInstruction(result);
	assertUniqueToolNames(frame);
	// Hand the render's metadata producers and effect declarations to the
	// session through the shared output channel — replaced wholesale each
	// render, so per-turn re-renders refresh the closures the same way tools
	// and instructions refresh.
	if (state?.output) {
		state.output.producers = {
			start: [...frame.metadataProducers.start],
			finish: [...frame.metadataProducers.finish],
		};
		state.output.effects = [...frame.effects];
	}
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
			...(frame.skills.length > 0 ? { skills: frame.skills } : {}),
			...(frame.subagents.length > 0 ? { subagents: frame.subagents } : {}),
		},
		structure: {
			capabilities: frame.capabilities.map((record) => record.capability),
			capabilityNames: frame.capabilities.map((record) => record.capability.name || '(anonymous)'),
			toolNames: tools.map((tool) => tool.name),
			stateNames: [...frame.stateNames],
			messageDataNames: [...frame.messageDataNames],
			skillNames: frame.skills.map((skill) => skill.name),
			subagentNames: frame.subagents.map((subagent) => subagent.name),
			hasSandbox: frame.sandbox !== undefined,
			effectCount: frame.effects.length,
		},
	};
}

/**
 * Render a capability-backed delegate into the self-contained profile shape
 * the task machinery consumes. Runs at delegation time, in its own frame,
 * fresh per task — closures read current values, and two delegations to the
 * same subagent render independently. Subagent frames reject root-scoped
 * hooks (`useState`, `useSandbox`); nested `useSubagent` declarations pass
 * through for the delegate's own task tool, governed by the delegation
 * depth cap.
 *
 * `delivery` is the parent's task prompt as a `DeliveredMessage` — the
 * delegate's triggering input, readable via `useDelivery()` exactly like a
 * root agent reads its dispatch.
 */
export function resolveSubagentDefinition(
	subagent: SubagentDefinition,
	delivery?: DeliveredMessage,
): AgentProfile {
	const { result, frame } = renderWithFrame(
		subagent.capabilities as () => unknown,
		delivery ? { snapshot: new Map(), store: undefined, delivery } : undefined,
		'subagent',
	);
	assertAgentInstruction(result);
	assertUniqueToolNames(frame);
	const instructions = composeAgentDocument(result, frame);
	const tools = [...frame.root.tools, ...frame.capabilities.flatMap((record) => record.tools)];
	return {
		name: subagent.name,
		description: subagent.description,
		...(subagent.model !== undefined ? { model: subagent.model } : {}),
		...(subagent.thinkingLevel !== undefined ? { thinkingLevel: subagent.thinkingLevel } : {}),
		...(instructions !== undefined ? { instructions } : {}),
		...(tools.length > 0 ? { tools } : {}),
		...(frame.skills.length > 0 ? { skills: frame.skills } : {}),
		...(frame.subagents.length > 0 ? { subagents: frame.subagents } : {}),
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
	const messageDataDelta = setDelta(previous.messageDataNames, next.messageDataNames);
	if (messageDataDelta) problems.push(`message data ${messageDataDelta}`);
	const skillDelta = setDelta(previous.skillNames, next.skillNames);
	if (skillDelta) problems.push(`skills ${skillDelta}`);
	const subagentDelta = setDelta(previous.subagentNames, next.subagentNames);
	if (subagentDelta) problems.push(`subagents ${subagentDelta}`);
	if (previous.hasSandbox !== next.hasSandbox) {
		problems.push(`sandbox ${next.hasSandbox ? 'added' : 'removed'}`);
	}
	if (previous.effectCount !== next.effectCount) {
		problems.push(`effect count changed (${previous.effectCount} → ${next.effectCount})`);
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
