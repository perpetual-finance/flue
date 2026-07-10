import { describe, expect, it } from 'vitest';
import { agentBindingName, agentClassName } from '../src/agent-scan.ts';
import { generateCloudflareEntry } from '../src/cloudflare-entry.ts';

function scanned(identity: string, filePath: string) {
	return {
		identity,
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
				scanned('echo', '/proj/src/agents/echo.ts'),
				scanned('triage-bot', '/proj/src/agents/triage-bot.ts'),
			],
		});

		// User app + agent module imports by absolute path.
		expect(entry).toContain(`import userApp from "/proj/src/app.ts";`);
		expect(entry).toContain(`import * as __flue_agent_0__ from "/proj/src/agents/echo.ts";`);
		expect(entry).toContain(`import * as __flue_agent_1__ from "/proj/src/agents/triage-bot.ts";`);

		// The scan IS the registration.
		expect(entry).toContain(`{ identity: "echo", module: __flue_agent_0__ },`);
		expect(entry).toContain(`{ identity: "triage-bot", module: __flue_agent_1__ },`);
		expect(entry).toContain('registerFlueAgents(registrations);');

		// Identity → Durable Object binding join (name(identity) → binding).
		expect(entry).toContain(
			`"echo": { bindingName: "FLUE_ECHO_AGENT", className: "FlueEchoAgent" },`,
		);
		expect(entry).toContain(
			`"triage-bot": { bindingName: "FLUE_TRIAGE_BOT_AGENT", className: "FlueTriageBotAgent" },`,
		);

		// One exported DO class per scanned agent, built by the shared factory
		// with the module's cloudflare extension export. Reflect.get, not a
		// static member access: the export is optional, and a direct
		// `__flue_agent_0__.cloudflare` makes bundlers warn (IMPORT_IS_UNDEFINED)
		// for every agent module without it.
		expect(entry).toContain('export const FlueEchoAgent = createFlueAgentClass({');
		expect(entry).toContain('export const FlueTriageBotAgent = createFlueAgentClass({');
		expect(entry).toContain("extension: Reflect.get(__flue_agent_0__, 'cloudflare'),");

		// Runtime seed carries only the conversation-era config shape.
		expect(entry).toContain(`target: 'cloudflare',`);
		expect(entry).not.toContain('workflows');
		expect(entry).not.toContain('routeWorkflowRequest');

		// Without a cloudflare.ts there is nothing to spread or re-export.
		expect(entry).toContain('const userCloudflare = {};');
		expect(entry).not.toContain('export * from');
	});

	it('composes cloudflare.ts handlers with the fetch-must-not-exist validation', () => {
		const entry = generateCloudflareEntry({
			appEntry: '/proj/src/app.ts',
			cloudflareEntry: '/proj/src/cloudflare.ts',
			agents: [scanned('echo', '/proj/src/agents/echo.ts')],
		});

		expect(entry).toContain(
			`import * as userCloudflareModule from "/proj/src/cloudflare.ts";`,
		);
		expect(entry).toContain(`export * from "/proj/src/cloudflare.ts";`);
		expect(entry).toContain('const userCloudflare = userCloudflareModule;');
		// Reserved-name and shape validation with the legacy-parity messages.
		expect(entry).toContain('conflicts with a Flue-generated Worker export. Rename the authored export.');
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
			agents: [scanned('echo', 'C:\\proj\\src\\agents\\echo.ts')],
		});
		expect(entry).toContain(`import userApp from "C:/proj/src/app.ts";`);
		expect(entry).toContain(`import * as __flue_agent_0__ from "C:/proj/src/agents/echo.ts";`);
	});
});
