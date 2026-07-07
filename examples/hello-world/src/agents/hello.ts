'use agent';
import { defineAgent, useTool } from '@flue/runtime';
import * as v from 'valibot';

/**
 * The former `hello` workflow as a model-callable tool: a deterministic body
 * that prompts a child session for a structured result and logs it.
 *
 * Run it directly:
 *   flue run src/agents/hello.ts --message "Run the hello tool."
 */
function Hello() {
	useTool({
		name: 'hello',
		description: 'Solve a small arithmetic prompt and return the structured answer.',
		harness: true,
		async run({ harness, log }) {
			const session = await harness.session();
			const response = await session.prompt('What is 2 + 2? Return only the number.', {
				result: v.object({ answer: v.number() }),
			});
			log.info('solved arithmetic prompt', {
				answer: response.data.answer,
				tokens: response.usage.totalTokens,
				provider: response.model.provider,
				model: response.model.id,
			});
			await session.shell('cat AGENTS.md');
			return response.data;
		},
	});
	return 'When asked to run a demo, call the `hello` tool and report its result.';
}

export default defineAgent(Hello, { model: 'anthropic/claude-sonnet-4-6' });
