import { ToolNameConflictError } from '../errors.ts';
import type {
	AgentFunction,
	AgentProps,
	AgentRuntimeConfig,
	DeliveredMessage,
	FunctionAgentConfig,
	ResolvedSubagent,
	SubagentDefinition,
} from '../types.ts';
import { type RenderFrame, type RenderStateContext, renderWithFrame } from './frame.ts';

/**
 * The props the runtime passes to the root agent function. On a bare render
 * with no backing instance (tests/tooling), reading `id` throws — the same
 * contract as `useDelivery()` on an unbacked render. A subagent's agent
 * function never receives props: a delegate runs in isolation from the
 * parent.
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
 * Run one render of an agent function: invoke it inside a fresh frame,
 * validate the returned instruction, and map the static config + hook
 * attachments onto the internal runtime-config shape the initialization path
 * consumes (the same shape a legacy `defineAgent` initializer returns).
 * Config field values beyond shape (thinking levels, compaction/durability
 * fields) are validated downstream by the shared profile asserts.
 */
export function renderAgentFunction(
	agent: AgentFunction<AgentProps>,
	config: FunctionAgentConfig,
	state?: RenderStateContext,
): AgentRuntimeConfig {
	return renderAgentFunctionWithStructure(agent, config, state).config;
}

/**
 * The structural fingerprint of one render, for the invariance guard: tools
 * by NAME only (schemas may legally vary with state — labels fetched at
 * runtime, say — without counting as a structural change); state by name;
 * the sandbox by presence (the environment is built once at initialization,
 * so only a conditional `useSandbox` counts as a structural change).
 */
export interface AgentRenderStructure {
	toolNames: readonly string[];
	stateNames: readonly string[];
	messageDataNames: readonly string[];
	skillNames: readonly string[];
	subagentNames: readonly string[];
	hasSandbox: boolean;
	/**
	 * Lifecycle declarations this render. Hooks have no names — identity is
	 * call order — so the counts (with the rules of hooks) pin the order.
	 */
	agentStartCount: number;
	agentFinishCount: number;
}

/** `renderAgentFunction` plus the render's structural fingerprint. */
export function renderAgentFunctionWithStructure(
	agent: AgentFunction<AgentProps>,
	config: FunctionAgentConfig,
	state?: RenderStateContext,
): { config: AgentRuntimeConfig; structure: AgentRenderStructure } {
	const props = agentPropsFor(state);
	const { result, frame } = renderWithFrame(() => agent(props), state);
	assertAgentInstruction(result);
	assertUniqueToolNames(frame);
	// Hand the render's metadata producers and lifecycle declarations to the
	// session through the shared output channel — replaced wholesale each
	// render, so per-turn re-renders refresh the closures the same way tools
	// and instructions refresh.
	if (state?.output) {
		state.output.producers = {
			start: [...frame.metadataProducers.start],
			finish: [...frame.metadataProducers.finish],
		};
		state.output.agentStarts = [...frame.agentStarts];
		state.output.agentFinishes = [...frame.agentFinishes];
	}
	const instructions = composeAgentDocument(result, frame);
	const tools = frame.root.tools;
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
			toolNames: tools.map((tool) => tool.name),
			stateNames: [...frame.stateNames],
			messageDataNames: [...frame.messageDataNames],
			skillNames: frame.skills.map((skill) => skill.name),
			subagentNames: frame.subagents.map((subagent) => subagent.name),
			hasSandbox: frame.sandbox !== undefined,
			agentStartCount: frame.agentStarts.length,
			agentFinishCount: frame.agentFinishes.length,
		},
	};
}

/**
 * Render a delegate's agent function into the self-contained profile shape
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
): ResolvedSubagent {
	const { result, frame } = renderWithFrame(
		subagent.agent as () => unknown,
		delivery ? { snapshot: new Map(), store: undefined, delivery } : undefined,
		'subagent',
	);
	assertAgentInstruction(result);
	assertUniqueToolNames(frame);
	const instructions = composeAgentDocument(result, frame);
	const tools = frame.root.tools;
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
 * hook calls are never conditional. State informs the agent (values, props,
 * guards, interpolated text) — it does not reshape it. Throws with the
 * precise delta when consecutive renders disagree.
 */
export function assertRenderStructureInvariance(
	previous: AgentRenderStructure,
	next: AgentRenderStructure,
): void {
	const problems: string[] = [];
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
	if (previous.agentStartCount !== next.agentStartCount) {
		problems.push(
			`useAgentStart count changed (${previous.agentStartCount} → ${next.agentStartCount})`,
		);
	}
	if (previous.agentFinishCount !== next.agentFinishCount) {
		problems.push(
			`useAgentFinish count changed (${previous.agentFinishCount} → ${next.agentFinishCount})`,
		);
	}
	if (problems.length > 0) {
		throw new Error(
			`[flue] The agent's render changed structure between turns: ${problems.join('; ')}. ` +
				'Hook calls must not be conditional — every render composes the same tools, state, and attachments. Drive behavior with state values, arguments, and tool guards instead.',
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
 * agent's returned instruction first, then `useInstruction` contributions in
 * call order. Authors own all formatting — the runtime only joins with blank
 * lines.
 */
function composeAgentDocument(base: string | undefined, frame: RenderFrame): string | undefined {
	const parts = [
		...(base !== undefined && base.length > 0 ? [base] : []),
		...frame.root.instructions,
	];
	if (parts.length === 0) return undefined;
	return parts.join('\n\n');
}

function assertUniqueToolNames(frame: RenderFrame): void {
	const seen = new Set<string>();
	const all = frame.root.tools;
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
			'[flue] Agent functions must be synchronous. Move async work into tools, actions, or resource factories.',
		);
	}
	if (value !== undefined && typeof value !== 'string') {
		throw new Error(
			'[flue] An agent returns its instruction string (or nothing). Model and settings belong in defineAgent(Agent, { model, ... }); everything else is composed with hooks in the body.',
		);
	}
}

function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
	return (
		typeof value === 'object' &&
		value !== null &&
		'then' in value &&
		typeof (value as { then: unknown }).then === 'function'
	);
}
