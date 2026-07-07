import * as v from 'valibot';
import { createAgentRouter } from './runtime/registration.ts';
import { assertToolDefinition } from './tool.ts';
import type {
	AgentDefinition,
	AgentInitializerContext,
	AgentProfile,
	AgentProps,
	AgentRuntimeConfig,
	Capability,
	DeclaredSubagent,
	FunctionAgentConfig,
	FunctionAgentDefinition,
	Skill,
	ThinkingLevel,
	ToolDefinition,
} from './types.ts';
import { isSubagentDefinition } from './types.ts';

const agentDefinitions = new WeakSet<object>();

const VALID_THINKING_LEVELS = {
	off: true,
	minimal: true,
	low: true,
	medium: true,
	high: true,
	xhigh: true,
} as const satisfies Record<ThinkingLevel, true>;

const AgentProfileSchema = v.strictObject(
	{
		name: v.optional(v.string()),
		description: v.optional(v.string()),
		model: v.optional(v.string()),
		instructions: v.optional(v.string()),
		skills: v.optional(v.array(v.unknown())),
		tools: v.optional(v.array(v.unknown())),
		subagents: v.optional(v.array(v.unknown())),
		thinkingLevel: v.optional(v.string()),
		compaction: v.optional(v.union([v.literal(false), v.looseObject({})])),
		durability: v.optional(v.looseObject({})),
	},
	(issue) =>
		issue.expected === 'never'
			? `received unknown agent profile field ${issue.received}`
			: issue.message,
);

// `name` is profile-only: an agent definition is addressed by its module filename,
// so a top-level name on the runtime config would have nothing to control.
const AGENT_RUNTIME_FIELDS = new Set(
	[...Object.keys(AgentProfileSchema.entries), 'profile', 'cwd', 'sandbox'].filter(
		(field) => field !== 'name',
	),
);

/**
 * Validates and returns a reusable agent profile. Use profiles as the baseline
 * for an agent definition or as named subagents available to `session.task()`.
 *
 * Throws when the profile contains unknown fields, invalid capabilities,
 * duplicate capability names, or circular subagents.
 */
export function defineAgentProfile(profile: AgentProfile): AgentProfile {
	assertAgentProfile(profile, 'defineAgentProfile()', new WeakSet());
	return profile;
}

const FunctionAgentConfigSchema = v.strictObject(
	{
		model: v.pipe(v.string(), v.minLength(1)),
		thinkingLevel: v.optional(v.string()),
		compaction: v.optional(v.union([v.literal(false), v.looseObject({})])),
		durability: v.optional(v.looseObject({})),
		cwd: v.optional(v.string()),
	},
	(issue) =>
		issue.expected === 'never'
			? `received unknown agent config field ${issue.received}`
			: issue.message,
);

/**
 * Defines an addressable agent. Default-export the returned value from a
 * `'use agent'` module. Two forms:
 *
 * **`defineAgent(Capability, config)`** — an agent is a capability given a
 * model. The capability function composes behavior with Flue Hooks and
 * returns the agent's instruction string; `config` is the static identity
 * (model, tuning) that never renders:
 *
 * ```ts
 * function Support() {
 *   useTool(lookupCase);
 *   return 'Operator-facing support agent. Work only from verified evidence.';
 * }
 * export default defineAgent(Support, { model: 'anthropic/claude-sonnet-4-6' });
 * ```
 *
 * **`defineAgent(initializer)`** (legacy) — an async initializer returning a
 * static runtime config. Runs whenever a runner initializes a root harness;
 * do not treat it as a one-time constructor for a persistent instance id.
 */
export function defineAgent<TEnv = Record<string, any>>(
	initialize: (
		context: AgentInitializerContext<TEnv>,
	) => AgentRuntimeConfig | Promise<AgentRuntimeConfig>,
): AgentDefinition<TEnv>;
export function defineAgent(
	agent: Capability<AgentProps>,
	config: FunctionAgentConfig,
): FunctionAgentDefinition;
export function defineAgent<TEnv = Record<string, any>>(
	initializeOrAgent:
		| ((context: AgentInitializerContext<TEnv>) => AgentRuntimeConfig | Promise<AgentRuntimeConfig>)
		| Capability<AgentProps>,
	config?: FunctionAgentConfig,
): AgentDefinition<TEnv> | FunctionAgentDefinition {
	if (typeof initializeOrAgent !== 'function') {
		throw new Error(
			'[flue] defineAgent() requires a function: defineAgent(Capability, { model }) or defineAgent(initializer).',
		);
	}
	if (config !== undefined) {
		const parsed = v.safeParse(FunctionAgentConfigSchema, config);
		if (!parsed.success) {
			throw new Error(
				`[flue] defineAgent() config is invalid: ${parsed.issues
					.map((issue) => issue.message)
					.join('; ')}.`,
			);
		}
		const agent: FunctionAgentDefinition = {
			__flueFunctionAgent: true as const,
			capability: initializeOrAgent as Capability<AgentProps>,
			config,
			// Pure router factory over the module's bound identity/metadata — see
			// createAgentRouter for the served routes and resolution rules.
			route: () => createAgentRouter(agent),
		};
		Object.freeze(agent);
		agentDefinitions.add(agent);
		return agent;
	}
	const initialize = initializeOrAgent as (
		context: AgentInitializerContext<TEnv>,
	) => AgentRuntimeConfig | Promise<AgentRuntimeConfig>;
	const agent: AgentDefinition<TEnv> = {
		__flueAgentDefinition: true as const,
		initialize,
		route: () => createAgentRouter(agent as AgentDefinition),
	};
	Object.freeze(agent);
	agentDefinitions.add(agent);
	return agent;
}

/** @deprecated Renamed to {@link defineAgent}. */
export function createAgent<TEnv = Record<string, any>>(
	initialize: (
		context: AgentInitializerContext<TEnv>,
	) => AgentRuntimeConfig | Promise<AgentRuntimeConfig>,
): AgentDefinition<TEnv> {
	return defineAgent(initialize);
}

export function assertResolvedAgentProfile(profile: AgentProfile, label: string): AgentProfile {
	assertAgentProfile(profile, label, new WeakSet());
	return profile;
}

export function resolveAgentProfile(options: AgentRuntimeConfig | undefined): AgentProfile {
	assertAgentRuntimeConfig(options);
	const profile = options?.profile;
	return {
		name: profile?.name,
		description: hasOwn(options, 'description') ? options?.description : profile?.description,
		model: hasOwn(options, 'model') ? options?.model : profile?.model,
		instructions: hasOwn(options, 'instructions') ? options?.instructions : profile?.instructions,
		skills: mergeArrays(profile?.skills, options?.skills),
		tools: mergeArrays(profile?.tools, options?.tools),
		subagents: mergeArrays(profile?.subagents, options?.subagents),
		thinkingLevel: hasOwn(options, 'thinkingLevel')
			? options?.thinkingLevel
			: profile?.thinkingLevel,
		compaction: hasOwn(options, 'compaction') ? options?.compaction : profile?.compaction,
		durability: hasOwn(options, 'durability') ? options?.durability : profile?.durability,
	};
}

export function extendAgentProfile(
	profile: AgentProfile,
	extensions: Pick<AgentProfile, 'skills' | 'tools' | 'subagents'>,
): AgentProfile {
	return {
		...profile,
		skills: mergeArrays(profile.skills, extensions.skills),
		tools: mergeArrays(profile.tools, extensions.tools),
		subagents: mergeArrays(profile.subagents, extensions.subagents),
	};
}

function hasOwn<T extends object, K extends PropertyKey>(
	value: T | undefined,
	key: K,
): value is T & Record<K, unknown> {
	return Boolean(value && Object.hasOwn(value, key));
}

function mergeArrays<T>(base: T[] | undefined, additions: T[] | undefined): T[] | undefined {
	if (base === undefined && additions === undefined) return undefined;
	return [...(base ?? []), ...(additions ?? [])];
}

function assertAgentRuntimeConfig(value: AgentRuntimeConfig | undefined): void {
	if (!value || typeof value !== 'object' || Array.isArray(value)) {
		throw new Error('[flue] defineAgent() initializer must return an agent runtime config object.');
	}
	for (const key of Object.keys(value)) {
		if (!AGENT_RUNTIME_FIELDS.has(key)) {
			throw new Error(
				`[flue] defineAgent() initializer returned unknown runtime config field "${key}".`,
			);
		}
	}
	if (value.profile !== undefined) {
		assertAgentProfile(value.profile, 'defineAgent() profile', new WeakSet());
	}
}

function assertAgentProfile(
	value: unknown,
	label: string,
	activeDefinitions: WeakSet<object>,
): asserts value is AgentProfile {
	const parsed = v.safeParse(AgentProfileSchema, value);
	if (!parsed.success) {
		throw new Error(
			`[flue] ${label} requires a valid agent profile: ${formatIssues(parsed.issues)}.`,
		);
	}

	const definition = parsed.output as AgentProfile;
	const source = value as object;
	if (activeDefinitions.has(source)) {
		throw new Error(`[flue] ${label} must not contain circular subagents.`);
	}
	activeDefinitions.add(source);

	if (definition.name !== undefined) assertAgentName(definition.name, `${label} name`);
	if (definition.description !== undefined)
		assertNonEmptyString(definition.description, `${label} description`);
	assertThinkingLevel(definition.thinkingLevel, label);
	assertCompaction(definition.compaction, label);
	assertDurability(definition.durability, label);
	assertTools(definition.tools, label);
	assertSkills(definition.skills, label);
	assertSubagents(definition.subagents, label, activeDefinitions);
	assertUniqueNames(definition.tools, `${label} tools`, 'tool');
	assertUniqueNames(definition.skills, `${label} skills`, 'skill');
	assertUniqueNames(definition.subagents, `${label} subagents`, 'subagent');

	activeDefinitions.delete(source);
}

function assertThinkingLevel(value: ThinkingLevel | undefined, label: string): void {
	if (value !== undefined && !(value in VALID_THINKING_LEVELS)) {
		throw new Error(
			`[flue] ${label} thinkingLevel must be one of: ${Object.keys(VALID_THINKING_LEVELS).join(', ')}.`,
		);
	}
}

function assertCompaction(definition: AgentProfile['compaction'], label: string): void {
	if (definition === undefined || definition === false) {
		return;
	}

	for (const key of Object.keys(definition)) {
		if (key !== 'reserveTokens' && key !== 'keepRecentTokens' && key !== 'model') {
			throw new Error(`[flue] ${label} compaction received unknown field "${key}".`);
		}
	}
	assertTokenCount(definition.reserveTokens, `${label} compaction.reserveTokens`);
	assertTokenCount(definition.keepRecentTokens, `${label} compaction.keepRecentTokens`);
	if (definition.model !== undefined && typeof definition.model !== 'string') {
		throw new Error(`[flue] ${label} compaction.model must be a string.`);
	}
}

function assertDurability(definition: AgentProfile['durability'], label: string): void {
	if (definition === undefined) return;
	for (const key of Object.keys(definition)) {
		if (key !== 'maxAttempts' && key !== 'timeoutMs') {
			throw new Error(`[flue] ${label} durability received unknown field "${key}".`);
		}
	}
	assertPositiveInteger(definition.maxAttempts, `${label} durability.maxAttempts`);
	assertPositiveInteger(definition.timeoutMs, `${label} durability.timeoutMs`);
}

function assertPositiveInteger(value: number | undefined, label: string): void {
	if (value === undefined) return;
	if (!Number.isFinite(value) || !Number.isInteger(value) || value <= 0) {
		throw new Error(`[flue] ${label} must be a positive integer.`);
	}
}

function assertTokenCount(value: number | undefined, label: string): void {
	if (value === undefined) {
		return;
	}
	if (!Number.isFinite(value) || !Number.isInteger(value) || value < 0) {
		throw new Error(`[flue] ${label} must be a non-negative integer.`);
	}
}

function assertTools(
	values: unknown[] | undefined,
	label: string,
): asserts values is ToolDefinition[] | undefined {
	for (const [index, value] of values?.entries() ?? []) {
		assertToolDefinition(value, `${label} tools[${index}]`);
	}
}

function assertSkills(
	values: unknown[] | undefined,
	label: string,
): asserts values is Skill[] | undefined {
	for (const [index, value] of values?.entries() ?? []) {
		if (!value || typeof value !== 'object') {
			throw new Error(`[flue] ${label} skills[${index}] must be a skill definition object.`);
		}
		const skill = value as Partial<Skill>;
		assertNonEmptyString(skill.name, `${label} skills[${index}].name`);
		assertNonEmptyString(skill.description, `${label} skills[${index}].description`);
	}
}

function assertSubagents(
	values: unknown[] | undefined,
	label: string,
	activeDefinitions: WeakSet<object>,
): asserts values is DeclaredSubagent[] | undefined {
	for (const [index, value] of values?.entries() ?? []) {
		if (!value || typeof value !== 'object') {
			throw new Error(`[flue] ${label} subagents[${index}] must be an agent definition object.`);
		}
		const subagent = value as Partial<AgentProfile>;
		assertAgentName(subagent.name, `${label} subagents[${index}].name`);
		if (subagent.durability !== undefined) {
			throw new Error(
				`[flue] ${label} subagents[${index}] must not declare durability. ` +
					'Delegated task sessions run inside the parent operation; configure durability on the agent definition instead.',
			);
		}
		// Capability-backed delegates (useSubagent) are validated at the hook
		// call site; their capabilities render at delegation time, so the
		// profile-shape assertions below do not apply to them.
		if (isSubagentDefinition(value as DeclaredSubagent)) continue;
		assertAgentProfile(value, `${label} subagents[${index}]`, activeDefinitions);
	}
}

function assertAgentName(value: unknown, label: string): asserts value is string {
	assertNonEmptyString(value, label);
	if (!/^[A-Za-z][A-Za-z0-9_-]*$/.test(value)) {
		throw new Error(
			`[flue] ${label} must start with a letter and contain only letters, numbers, "_", or "-".`,
		);
	}
}

function assertNonEmptyString(value: unknown, label: string): asserts value is string {
	if (typeof value !== 'string' || value.trim().length === 0) {
		throw new Error(`[flue] ${label} must be a non-empty string.`);
	}
}

function assertUniqueNames(
	values: Array<{ name?: string }> | undefined,
	label: string,
	kind: 'tool' | 'skill' | 'subagent',
): void {
	if (!values) {
		return;
	}

	const seen = new Set<string>();
	for (const value of values) {
		const name = value.name;
		if (!name) continue;
		if (seen.has(name)) {
			throw new Error(`[flue] ${label} must not contain duplicate ${kind} name "${name}".`);
		}
		seen.add(name);
	}
}

function formatIssues(issues: readonly v.BaseIssue<unknown>[]): string {
	return issues.map((issue) => issue.message).join('; ');
}
