import * as v from 'valibot';
import { createAgentRouter } from './runtime/registration.ts';
import { isValibotSchema } from './schema.ts';
import type {
	AgentFunction,
	AgentProps,
	FunctionAgentConfig,
	FunctionAgentDefinition,
	ThinkingLevel,
} from './types.ts';

const agentDefinitions = new WeakSet<object>();

const VALID_THINKING_LEVELS = {
	off: true,
	minimal: true,
	low: true,
	medium: true,
	high: true,
	xhigh: true,
} as const satisfies Record<ThinkingLevel, true>;

const FunctionAgentConfigSchema = v.strictObject(
	{
		model: v.pipe(v.string(), v.minLength(1)),
		thinkingLevel: v.optional(v.string()),
		compaction: v.optional(v.union([v.literal(false), v.looseObject({})])),
		durability: v.optional(v.looseObject({})),
		cwd: v.optional(v.string()),
		input: v.optional(v.unknown()),
	},
	(issue) =>
		issue.expected === 'never'
			? `received unknown agent config field ${issue.received}`
			: issue.message,
);

/**
 * Defines an addressable agent. Default-export the returned value from a
 * `'use agent'` module.
 *
 * An agent is an agent function given a model: the function composes
 * behavior with Flue Hooks and returns the agent's instruction string;
 * `config` is the static identity (model, tuning) that never renders:
 *
 * ```ts
 * function Support() {
 *   useTool(lookupCase);
 *   return 'Operator-facing support agent. Work only from verified evidence.';
 * }
 * export default defineAgent(Support, { model: 'anthropic/claude-sonnet-4-6' });
 * ```
 */
export function defineAgent(
	agent: AgentFunction<AgentProps>,
	config: FunctionAgentConfig,
): FunctionAgentDefinition {
	if (typeof agent !== 'function') {
		throw new Error('[flue] defineAgent() requires a function: defineAgent(Agent, { model }).');
	}
	const parsed = v.safeParse(FunctionAgentConfigSchema, config);
	if (!parsed.success) {
		throw new Error(
			`[flue] defineAgent() config is invalid: ${parsed.issues
				.map((issue) => issue.message)
				.join('; ')}.`,
		);
	}
	assertThinkingLevel(config.thinkingLevel, 'defineAgent() config');
	assertCompaction(config.compaction, 'defineAgent() config');
	assertDurability(config.durability, 'defineAgent() config');
	if (config.input !== undefined && !isValibotSchema(config.input)) {
		throw new Error(
			'[flue] defineAgent() config.input must be a Valibot schema for the instance creation data.',
		);
	}
	const definition: FunctionAgentDefinition = {
		__flueFunctionAgent: true as const,
		agent,
		config,
		// Pure router factory over the module's bound identity/metadata — see
		// createAgentRouter for the served routes and resolution rules.
		route: () => createAgentRouter(definition),
	};
	Object.freeze(definition);
	agentDefinitions.add(definition);
	return definition;
}

function assertThinkingLevel(value: ThinkingLevel | undefined, label: string): void {
	if (value !== undefined && !(value in VALID_THINKING_LEVELS)) {
		throw new Error(
			`[flue] ${label} thinkingLevel must be one of: ${Object.keys(VALID_THINKING_LEVELS).join(', ')}.`,
		);
	}
}

function assertCompaction(definition: FunctionAgentConfig['compaction'], label: string): void {
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

function assertDurability(definition: FunctionAgentConfig['durability'], label: string): void {
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
