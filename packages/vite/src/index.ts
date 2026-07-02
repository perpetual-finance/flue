/**
 * `@flue/vite` — the Vite plugin that makes a Vite project a Flue app.
 *
 * Phase 2 of the redesign ships only the shared "use agent" scanner; the
 * plugin itself lands in Phase 3
 * (plans/2026-07-02-vite-plugin-explicit-routing-redesign.md).
 */
export type { AgentScanResult, ScanAgentsOptions } from './agent-scan.ts';
export {
	AGENT_DIRECTIVE,
	AGENT_IDENTITY_PATTERN,
	AgentModuleParseError,
	AgentScanError,
	agentBindingName,
	agentClassName,
	DuplicateAgentIdentityError,
	InvalidAgentIdentityError,
	scanAgents,
} from './agent-scan.ts';
