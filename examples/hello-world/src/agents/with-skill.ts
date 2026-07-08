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
		async run({ harness, data }) {
			const { data: result } = await harness.skill('greet', {
				args: { name: data.name ?? 'World' },
				result: v.object({ greeting: v.string() }),
			});
			return result;
		},
	});
	return 'When asked to run a demo, call the `greet-with-skill` tool and report its result.';
}

export default defineAgent(WithSkill, { model: 'anthropic/claude-sonnet-4-6' });
