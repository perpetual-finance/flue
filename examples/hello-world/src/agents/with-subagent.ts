'use agent';
import { defineAction, defineAgent, defineAgentProfile } from '@flue/runtime';
import * as v from 'valibot';

const greeter = defineAgentProfile({
	name: 'greeter',
	instructions: 'Write one warm, concise greeting.',
});

const subagentGreet = defineAction({
	name: 'subagent-greet',
	description: 'Delegate a greeting to the `greeter` subagent and return the structured result.',
	input: v.object({ name: v.optional(v.string()) }),
	async run({ harness, input }) {
		const session = await harness.session();
		const { data } = await session.task(`Greet the user named "${input.name ?? 'Developer'}".`, {
			agent: 'greeter',
			result: v.object({ greeting: v.string() }),
		});
		return data;
	},
});

export default defineAgent(() => ({
	model: 'anthropic/claude-sonnet-4-6',
	subagents: [greeter],
	instructions:
		'When asked to run a demo, call the `subagent-greet` action and report its result.',
	actions: [subagentGreet],
}));
