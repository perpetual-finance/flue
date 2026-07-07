import {
	type FauxProviderRegistration,
	fauxAssistantMessage,
	registerFauxProvider,
} from '@earendil-works/pi-ai/compat';
import { afterEach, describe, expect, it } from 'vitest';
import { renderAgentFunction } from '../src/hooks/render.ts';
import { type AgentProps, defineAgent, useSubagent, useTool } from '../src/index.ts';
import { createFlueContext } from '../src/internal.ts';
import { createNoopSessionEnv } from './fixtures/session-env.ts';

const providers: FauxProviderRegistration[] = [];

afterEach(() => {
	for (const provider of providers.splice(0)) provider.unregister();
});

function createProvider(): FauxProviderRegistration {
	const provider = registerFauxProvider({ provider: `agent-props-${crypto.randomUUID()}` });
	providers.push(provider);
	return provider;
}

describe('AgentProps', () => {
	it('passes the instance id to the root capability on every render', async () => {
		const provider = createProvider();
		let systemPrompt: string | undefined;
		provider.setResponses([
			(context) => {
				systemPrompt = context.systemPrompt;
				return fauxAssistantMessage('ok');
			},
		]);
		const seen: string[] = [];
		const agent = defineAgent(
			({ id }: AgentProps) => {
				seen.push(id);
				return `You are bound to ${id}.`;
			},
			{ model: `${provider.getModel().provider}/${provider.getModel().id}` },
		);
		const ctx = createFlueContext({
			id: 'slack:C123:1701.42',
			env: {},
			agentConfig: { resolveModel: () => provider.getModel() },
			createDefaultEnv: async () => createNoopSessionEnv(),
		});
		const harness = await ctx.initializeRootHarness(agent);
		const session = await harness.session();
		await session.prompt('hello');

		expect(seen.length).toBeGreaterThanOrEqual(1);
		expect(new Set(seen)).toEqual(new Set(['slack:C123:1701.42']));
		expect(systemPrompt).toContain('You are bound to slack:C123:1701.42.');
	});

	it('throws a named error when props.id is read on an unbacked render', () => {
		expect(() =>
			renderAgentFunction(({ id }: AgentProps) => `bound to ${id}`, { model: 'test/model' }),
		).toThrow('no agent instance behind it');
	});

	it('renders zero-argument agent functions unchanged', () => {
		const config = renderAgentFunction(() => 'No props needed.', { model: 'test/model' });
		expect(config.instructions).toBe('No props needed.');
	});

	it('does not pass props to a subagent\'s agent function — delegates run in isolation', async () => {
		const provider = createProvider();
		provider.setResponses([fauxAssistantMessage('ok')]);
		let delegateArgCount: number | undefined;
		const agent = defineAgent(
			({ id }: AgentProps) => {
				useSubagent({
					name: 'worker',
					description: 'Isolated delegate.',
					agent: function Worker(...args: unknown[]) {
						delegateArgCount = args.length;
						return 'Delegate instruction.';
					} as () => string,
				});
				useTool({
					name: 'noop',
					description: 'No-op.',
					run: () => 'ok',
				});
				return `Root for ${id}.`;
			},
			{ model: `${provider.getModel().provider}/${provider.getModel().id}` },
		);
		const ctx = createFlueContext({
			id: 'isolation-check',
			env: {},
			agentConfig: { resolveModel: () => provider.getModel() },
			createDefaultEnv: async () => createNoopSessionEnv(),
		});
		const harness = await ctx.initializeRootHarness(agent);
		const session = await harness.session();
		provider.setResponses([fauxAssistantMessage('delegate reply')]);
		await session.task('do the work', { agent: 'worker' });

		expect(delegateArgCount).toBe(0);
	});
});
