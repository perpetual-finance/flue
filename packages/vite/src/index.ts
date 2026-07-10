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
 * See plans/2026-07-02-vite-plugin-explicit-routing-redesign.md. Targets:
 * Node (`flue()` alone) and Cloudflare (`flue()` before a sibling
 * `cloudflare()` from `@cloudflare/vite-plugin`).
 */
export type { AgentModuleScan, AgentScanResult, ScanAgentsOptions } from './agent-scan.ts';
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
	InvalidAgentNameExportError,
	isAgentModulePath,
	programBodyHasAgentDirective,
	scanAgentModuleCode,
	scanAgents,
} from './agent-scan.ts';
export type { FlueResolvedProjectInfo, FlueVitePluginApi } from './flue-plugin.ts';
export { flue } from './flue-plugin.ts';
