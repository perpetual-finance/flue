'use agent';
import { bash, defineAction, defineAgent, defineTool } from '@flue/runtime';
import { Bash, InMemoryFs } from 'just-bash';
import * as v from 'valibot';

const toolsTest = defineAction({
	name: 'tools-test',
	description: 'Exercise a per-prompt custom tool and the task tool.',
	async run({ harness }) {
		const session = await harness.session();
		const results: Record<string, boolean> = {};
		const calculator = defineTool({
			name: 'calculator',
			description: 'Perform arithmetic. Returns the numeric result as a string.',
			input: v.object({ expression: v.string() }),
			run: async ({ input }) => String(Function(`"use strict"; return (${input.expression})`)()),
		});
		const { text } = await session.prompt(
			'Use the calculator tool to compute 7 * 6. Tell me the result.',
			{ tools: [calculator] },
		);
		results['custom tool works'] = text.includes('42');
		await session.shell('mkdir -p /home/user/task-workspace');
		await session.shell(
			'echo "You are a math helper. Always respond with just the numeric answer, nothing else." > /home/user/task-workspace/AGENTS.md',
		);
		const taskResponse = await session.prompt(
			'Use the task tool with cwd /home/user/task-workspace to ask: "What is 100 + 23?"',
		);
		results['task tool works'] = taskResponse.text.includes('123');
		return { results, allPassed: Object.values(results).every(Boolean) };
	},
});

export default defineAgent(() => {
	const fs = new InMemoryFs();
	return {
		sandbox: bash(() => new Bash({ fs, network: { dangerouslyAllowFullInternetAccess: true } })),
		model: 'anthropic/claude-sonnet-4-6',
		instructions: 'When asked to run a demo, call the `tools-test` action and report its result.',
		actions: [toolsTest],
	};
});
