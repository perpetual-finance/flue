'use agent';
import { defineAgent, useSandbox, useTool } from '@flue/runtime';
import { local } from '@flue/runtime/node';
import * as v from 'valibot';

function WithSkill() {
	useSandbox(local());
	useTool({
		name: 'greet-with-skill',
		description: 'Run the packaged `greet` skill for a name and return its structured greeting.',
		input: v.object({ name: v.optional(v.string()) }),
		harness: true,
		async run({ harness, input }) {
			const session = await harness.session();
			const { data } = await session.skill('greet', {
				args: { name: input.name ?? 'World' },
				result: v.object({ greeting: v.string() }),
			});
			return data;
		},
	});
	return 'When asked to run a demo, call the `greet-with-skill` tool and report its result.';
}

export default defineAgent(WithSkill, { model: 'anthropic/claude-sonnet-4-6' });
