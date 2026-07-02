/**
 * `@flue/vite` — the Vite plugin that makes a Vite project a Flue app.
 *
 * ```ts
 * // vite.config.ts
 * import { defineConfig } from 'vite';
 * import { flue } from '@flue/vite';
 * export default defineConfig({ plugins: [flue()] });
 * ```
 *
 * See plans/2026-07-02-vite-plugin-explicit-routing-redesign.md. Phase 3
 * ships the Node target; the Cloudflare adapter lands in Phase 4.
 */
export type { AgentScanResult, ScanAgentsOptions } from './agent-scan.ts';
export {
	AGENT_DIRECTIVE,
	AGENT_IDENTITY_PATTERN,
	AgentModuleParseError,
	AgentScanError,
	agentBindingName,
	agentClassName,
	codeHasAgentDirective,
	DuplicateAgentIdentityError,
	InvalidAgentIdentityError,
	isAgentModulePath,
	programBodyHasAgentDirective,
	scanAgents,
} from './agent-scan.ts';
export type { FlueResolvedProjectInfo, FlueVitePluginApi } from './flue-plugin.ts';
export { flue } from './flue-plugin.ts';
