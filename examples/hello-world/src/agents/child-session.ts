'use agent';
import { bash, defineAction, defineAgent } from '@flue/runtime';
import { Bash, InMemoryFs } from 'just-bash';

const childSession = defineAction({
	name: 'child-session',
	description: 'Exercise session.task() child sessions and verify context discovery.',
	async run({ harness }) {
		const session = await harness.session();
		const results: Record<string, boolean> = {};
		await session.shell('mkdir -p /home/user/task-workspace');
		await session.shell(
			'echo "You are a task agent. Always respond with the prefix [TASK]." > /home/user/task-workspace/AGENTS.md',
		);
		const taskResult = await session.task('Say hello. Keep it very brief.', {
			cwd: '/home/user/task-workspace',
		});
		results['task returns result'] = taskResult.text.length > 0;
		results['task discovers context'] = taskResult.text.includes('[TASK]');
		const parentResult = await session.prompt('What is 1 + 1? Reply with just the number.');
		results['parent works after task'] = parentResult.text.includes('2');
		return { results, allPassed: Object.values(results).every(Boolean) };
	},
});

export default defineAgent(() => {
	const fs = new InMemoryFs();
	return {
		sandbox: bash(() => new Bash({ fs, network: { dangerouslyAllowFullInternetAccess: true } })),
		model: 'anthropic/claude-sonnet-4-6',
		instructions:
			'When asked to run a demo, call the `child-session` action and report its result.',
		actions: [childSession],
	};
});
