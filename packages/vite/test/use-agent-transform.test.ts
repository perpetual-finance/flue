import { describe, expect, it } from 'vitest';
import { transformUseAgentModule } from '../src/use-agent-transform.ts';

const ID = '/project/src/agents/triage.ts';

function transform(code: string) {
	return transformUseAgentModule({ code, id: ID, filePath: ID, identity: 'triage' });
}

describe('transformUseAgentModule', () => {
	it('appends the binding call with the identity and only the present named exports', async () => {
		const result = await transform(
			[
				`'use agent';`,
				`import { defineAgent } from '@flue/runtime';`,
				`export default defineAgent(() => ({ model: 'anthropic/claude-haiku-4-5' }));`,
				`export const route = async (_c, next) => next();`,
				`export const description = 'Triage agent';`,
			].join('\n'),
		);
		expect(result).not.toBeNull();
		expect(result?.code).toContain(
			`import { __flueBindAgentModule as __flue_bind_agent_module__ } from '@flue/runtime';`,
		);
		expect(result?.code).toContain(`import * as __flue_agent_module__ from ${JSON.stringify(ID)};`);
		expect(result?.code).toContain(
			`__flue_bind_agent_module__(__flue_agent_module__.default, { identity: "triage", route: __flue_agent_module__.route, description: __flue_agent_module__.description });`,
		);
		expect(result?.code).not.toContain('attachments:');
		expect(result?.map).toBeDefined();
		// The emitted map must be self-contained: source + original text, so
		// composed sourcemaps never lose the authored module.
		expect(result?.map.sources).toEqual([ID]);
		expect(result?.map.sourcesContent?.[0]).toContain(`'use agent';`);
	});

	it('detects renamed export specifiers and export-from declarations', async () => {
		const result = await transform(
			[
				`'use agent';`,
				`import { defineAgent } from '@flue/runtime';`,
				`const authMiddleware = async (_c, next) => next();`,
				`const agent = defineAgent(() => ({ model: 'anthropic/claude-haiku-4-5' }));`,
				`export { agent as default, authMiddleware as route };`,
				`export { attachments } from './middleware.ts';`,
			].join('\n'),
		);
		expect(result?.code).toContain('route: __flue_agent_module__.route');
		expect(result?.code).toContain('attachments: __flue_agent_module__.attachments');
	});

	it('throws with the directive location when a marked module has no default export', async () => {
		await expect(
			transform([`'use agent';`, `export const route = async (_c, next) => next();`].join('\n')),
		).rejects.toThrow(`Agent module ${ID}:1:1 declares 'use agent' but has no default export`);
	});

	it('returns null when the directive text appears outside the directive prologue', async () => {
		const result = await transform(
			[
				`import { defineAgent } from '@flue/runtime';`,
				`const note = 'use agent';`,
				`export default defineAgent(() => ({ model: 'anthropic/claude-haiku-4-5', instructions: note }));`,
			].join('\n'),
		);
		expect(result).toBeNull();
	});
});
