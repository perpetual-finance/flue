import { describe, expect, it } from 'vitest';
import { agentBindingName, agentClassName } from '../src/agent-scan.ts';
import { generateCloudflareEntry } from '../src/cloudflare-entry.ts';

function scanned(identity: string, filePath: string, exportName = identity) {
	return {
		identity,
		exportName,
		filePath,
		className: agentClassName(identity),
		bindingName: agentBindingName(identity),
	};
}

describe('generateCloudflareEntry()', () => {
	it('joins the scanned agent set to the runtime factories', () => {
		const entry = generateCloudflareEntry({
			appEntry: '/proj/src/app.ts',
			cloudflareEntry: undefined,
			agents: [
				scanned('Echo', '/proj/src/agents/echo.ts'),
				scanned('triage-bot', '/proj/src/agents/triage-bot.ts', 'Triage'),
			],
		});

		// User app + agent module imports by absolute path.
		expect(entry).toContain(`import userApp from "/proj/src/app.ts";`);
		expect(entry).toContain(
			`import * as __flue_agent_module_0__ from "/proj/src/agents/echo.ts";`,
		);
		expect(entry).toContain(
			`import * as __flue_agent_module_1__ from "/proj/src/agents/triage-bot.ts";`,
		);

		// The scan IS the registration — one entry per agent export.
		expect(entry).toContain(`{ identity: "Echo", agent: __flue_agent_module_0__["Echo"] },`);
		expect(entry).toContain(
			`{ identity: "triage-bot", agent: __flue_agent_module_1__["Triage"] },`,
		);
		expect(entry).toContain('registerFlueAgents(registrations);');

		// Identity → Durable Object binding join (name(identity) → binding).
		expect(entry).toContain(
			`"Echo": { bindingName: "FLUE_ECHO_AGENT", className: "FlueEchoAgent" },`,
		);
		expect(entry).toContain(
			`"triage-bot": { bindingName: "FLUE_TRIAGE_BOT_AGENT", className: "FlueTriageBotAgent" },`,
		);

		// One exported DO class per scanned agent, built by the shared factory
		// with the module's cloudflare extension export. Reflect.get, not a
		// static member access: the export is optional, and a direct
		// `__flue_agent_module_0__.cloudflare` makes bundlers warn
		// (IMPORT_IS_UNDEFINED) for every agent module without it.
		expect(entry).toContain('export const FlueEchoAgent = createFlueAgentClass({');
		expect(entry).toContain('export const FlueTriageBotAgent = createFlueAgentClass({');
		expect(entry).toContain("extension: Reflect.get(__flue_agent_module_0__, 'cloudflare'),");

		// Runtime seed carries only the conversation-era config shape.
		expect(entry).toContain(`target: 'cloudflare',`);
		expect(entry).not.toContain('workflows');
		expect(entry).not.toContain('routeWorkflowRequest');

		// Without a cloudflare.ts there is nothing to spread or re-export.
		expect(entry).toContain('const userCloudflare = {};');
		expect(entry).not.toContain('export * from');
	});

	it('emits one import per module file and one DO class per agent export', () => {
		const entry = generateCloudflareEntry({
			appEntry: '/proj/src/app.ts',
			cloudflareEntry: undefined,
			agents: [
				scanned('Zeta', '/proj/src/agents/team.ts', 'Zeta'),
				scanned('Alpha', '/proj/src/agents/team.ts', 'Alpha'),
			],
		});

		// One namespace import for the shared file.
		expect(entry).toContain(`import * as __flue_agent_module_0__ from "/proj/src/agents/team.ts";`);
		expect(entry).not.toContain('__flue_agent_module_1__');

		// Two registrations and two DO classes off the same namespace.
		expect(entry).toContain(`{ identity: "Zeta", agent: __flue_agent_module_0__["Zeta"] },`);
		expect(entry).toContain(`{ identity: "Alpha", agent: __flue_agent_module_0__["Alpha"] },`);
		expect(entry).toContain('export const FlueZetaAgent = createFlueAgentClass({');
		expect(entry).toContain('export const FlueAlphaAgent = createFlueAgentClass({');
	});

	it('composes cloudflare.ts handlers with the fetch-must-not-exist validation', () => {
		const entry = generateCloudflareEntry({
			appEntry: '/proj/src/app.ts',
			cloudflareEntry: '/proj/src/cloudflare.ts',
			agents: [scanned('Echo', '/proj/src/agents/echo.ts')],
		});

		expect(entry).toContain(`import * as userCloudflareModule from "/proj/src/cloudflare.ts";`);
		expect(entry).toContain(`export * from "/proj/src/cloudflare.ts";`);
		expect(entry).toContain('const userCloudflare = userCloudflareModule;');
		// Reserved-name and shape validation with the legacy-parity messages.
		expect(entry).toContain(
			'conflicts with a Flue-generated Worker export. Rename the authored export.',
		);
		expect(entry).toContain(
			`throw new Error('[flue] cloudflare.ts default export must be an object containing non-HTTP Worker handlers.');`,
		);
		expect(entry).toContain(
			`throw new Error('[flue] cloudflare.ts default export must not define fetch. Use app.ts for custom HTTP handling.');`,
		);
		expect(entry).toContain(JSON.stringify(['FlueEchoAgent']));
		// Worker default export: spread handlers, fetch pipes to the user app.
		expect(entry).toContain('...cloudflareHandlers,');
	});

	it('normalizes Windows path separators in generated import specifiers', () => {
		const entry = generateCloudflareEntry({
			appEntry: 'C:\\proj\\src\\app.ts',
			cloudflareEntry: undefined,
			agents: [scanned('Echo', 'C:\\proj\\src\\agents\\echo.ts')],
		});
		expect(entry).toContain(`import userApp from "C:/proj/src/app.ts";`);
		expect(entry).toContain(
			`import * as __flue_agent_module_0__ from "C:/proj/src/agents/echo.ts";`,
		);
	});
});
