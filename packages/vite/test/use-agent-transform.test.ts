import { describe, expect, it } from 'vitest';
import type { UseAgentTransformAgent } from '../src/use-agent-transform.ts';
import { transformUseAgentModule } from '../src/use-agent-transform.ts';

const ID = '/project/src/agents/triage.ts';

function transform(code: string, agents: readonly UseAgentTransformAgent[]) {
	return transformUseAgentModule({ code, id: ID, filePath: ID, agents });
}

describe('transformUseAgentModule', () => {
	it('appends one identity-binding call per agent, stamping the identity literal', async () => {
		const result = await transform(
			[
				`'use agent';`,
				`export function Triage() { return 'triage'; }`,
				`export const Escalation = () => 'escalate';`,
				`Escalation.agentName = 'escalation-bot';`,
			].join('\n'),
			[
				{ exportName: 'Triage', identity: 'Triage' },
				{ exportName: 'Escalation', identity: 'escalation-bot' },
			],
		);
		expect(result).not.toBeNull();
		expect(result?.code).toContain(
			`import { __flueBindAgentModule as __flue_bind_agent_module__ } from '@flue/runtime';`,
		);
		expect(result?.code).toContain(`import * as __flue_agent_module__ from ${JSON.stringify(ID)};`);
		expect(result?.code).toContain(
			`__flue_bind_agent_module__(__flue_agent_module__["Triage"], { identity: "Triage" });`,
		);
		expect(result?.code).toContain(
			`__flue_bind_agent_module__(__flue_agent_module__["Escalation"], { identity: "escalation-bot" });`,
		);
		expect(result?.map).toBeDefined();
		// The emitted map must be self-contained: source + original text, so
		// composed sourcemaps never lose the authored module.
		expect(result?.map.sources).toEqual([ID]);
		expect(result?.map.sourcesContent?.[0]).toContain(`'use agent';`);
	});

	it('binds default-exported agents through the namespace default member', async () => {
		const result = await transform(
			[`'use agent';`, `export default function Main() { return 'x'; }`].join('\n'),
			[{ exportName: 'default', identity: 'Main' }],
		);
		expect(result?.code).toContain(
			`__flue_bind_agent_module__(__flue_agent_module__["default"], { identity: "Main" });`,
		);
	});

	it('returns null when the directive text appears outside the directive prologue', async () => {
		const result = await transform(
			[
				`const note = 'use agent';`,
				`export function Agent() {`,
				`	return note;`,
				`}`,
			].join('\n'),
			[{ exportName: 'Agent', identity: 'Agent' }],
		);
		expect(result).toBeNull();
	});
});
