'use agent';
import { defineAction, defineAgent } from '@flue/runtime';
import { local } from '@flue/runtime/node';
import * as v from 'valibot';

const greetWithSkill = defineAction({
	name: 'greet-with-skill',
	description: 'Run the packaged `greet` skill for a name and return its structured greeting.',
	input: v.object({ name: v.optional(v.string()) }),
	async run({ harness, input }) {
		const session = await harness.session();
		const { data } = await session.skill('greet', {
			args: { name: input.name ?? 'World' },
			result: v.object({ greeting: v.string() }),
		});
		return data;
	},
});

export default defineAgent(() => ({
	sandbox: local(),
	model: 'anthropic/claude-sonnet-4-6',
	instructions:
		'When asked to run a demo, call the `greet-with-skill` action and report its result.',
	actions: [greetWithSkill],
}));
