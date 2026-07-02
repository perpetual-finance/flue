'use agent';
import { defineAction, defineAgent } from '@flue/runtime';
import * as v from 'valibot';

/**
 * The former `hello` workflow as a model-callable action: a deterministic
 * body that prompts a child session for a structured result and logs it.
 *
 * Run it directly:
 *   flue run src/agents/hello.ts --message "Run the hello action."
 */
const hello = defineAction({
	name: 'hello',
	description: 'Solve a small arithmetic prompt and return the structured answer.',
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

export default defineAgent(() => ({
	model: 'anthropic/claude-sonnet-4-6',
	instructions: 'When asked to run a demo, call the `hello` action and report its result.',
	actions: [hello],
}));
