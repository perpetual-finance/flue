'use agent';
import { defineAgent, useSubagent, useTool } from '@flue/runtime';
import * as v from 'valibot';

function Greeter() {
	return 'Write one warm, concise greeting.';
}

function WithSubagent() {
	useSubagent({
		name: 'greeter',
		description: 'Writes a short, warm greeting for a named user.',
		capabilities: Greeter,
	});
	useTool({
		name: 'subagent-greet',
		description: 'Delegate a greeting to the `greeter` subagent and return the structured result.',
		input: v.object({ name: v.optional(v.string()) }),
		harness: true,
		async run({ harness, data }) {
			const session = await harness.session();
			const { data: result } = await session.task(
				`Greet the user named "${data.name ?? 'Developer'}".`,
				{
					agent: 'greeter',
					result: v.object({ greeting: v.string() }),
				},
			);
			return result;
		},
	});
	return 'When asked to run a demo, call the `subagent-greet` tool and report its result.';
}

export default defineAgent(WithSubagent, { model: 'anthropic/claude-sonnet-4-6' });
