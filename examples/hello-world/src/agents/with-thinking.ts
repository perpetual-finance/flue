'use agent';
import { defineAction, defineAgent, defineAgentProfile } from '@flue/runtime';
import * as v from 'valibot';

const auditor = defineAgentProfile({ name: 'auditor', thinkingLevel: 'high' });

const thinkingTest = defineAction({
	name: 'thinking-test',
	description: 'Compare thinking levels across the parent session and a high-thinking subagent.',
	async run({ harness }) {
		const session = await harness.session();
		const Answer = v.object({ answer: v.string() });
		const fast = await session.prompt('In one word: capital of France?', { result: Answer });
		const careful = await session.task('Is 1009 prime? Justify briefly.', {
			agent: 'auditor',
			result: Answer,
		});
		const minimal = await session.task('Echo back: hello', {
			agent: 'auditor',
			thinkingLevel: 'minimal',
			result: Answer,
		});
		return { fast: fast.data, careful: careful.data, minimal: minimal.data };
	},
});

export default defineAgent(() => ({
	model: 'anthropic/claude-haiku-4-5',
	thinkingLevel: 'low',
	subagents: [auditor],
	instructions: 'When asked to run a demo, call the `thinking-test` action and report its result.',
	actions: [thinkingTest],
}));
