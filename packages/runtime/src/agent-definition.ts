import { createAgentRouter } from './runtime/registration.ts';
import type { AgentFunction, AgentProps, FunctionAgentDefinition } from './types.ts';

const agentDefinitions = new WeakSet<object>();

/**
 * Defines an addressable agent. Default-export the returned value from a
 * `'use agent'` module.
 *
 * An agent is an agent function: the function composes everything with Flue
 * Hooks — `useModel()` declares the model (required), `useTool()`/`useSkill()`
 * the resources — and returns the agent's instruction string:
 *
 * ```ts
 * function Support() {
 *   useModel('anthropic/claude-sonnet-4-6');
 *   useTool(lookupCase);
 *   return 'Operator-facing support agent. Work only from verified evidence.';
 * }
 * export default defineAgent(Support);
 * ```
 *
 * Supervisor-facing configuration lives beside the default export as module
 * exports: `name` (identity override), `description`, `route` (middleware),
 * `initialDataSchema` (creation-data validation), and `durability`
 * (submission retry policy).
 */
export function defineAgent(agent: AgentFunction<AgentProps>): FunctionAgentDefinition {
	if (typeof agent !== 'function') {
		throw new Error('[flue] defineAgent() requires a function: defineAgent(Agent).');
	}
	const definition: FunctionAgentDefinition = {
		__flueFunctionAgent: true as const,
		agent,
		// Pure router factory over the module's bound identity/metadata — see
		// createAgentRouter for the served routes and resolution rules.
		route: () => createAgentRouter(definition),
	};
	Object.freeze(definition);
	agentDefinitions.add(definition);
	return definition;
}
