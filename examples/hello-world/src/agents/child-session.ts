'use agent';
import { bash, defineAgent, useSandbox, useTool } from '@flue/runtime';
import { Bash, InMemoryFs } from 'just-bash';

/**
 * Demonstrates `harness.task()`: work delegated to a detached child
 * conversation (retained as a child of the harness's own conversation),
 * with its own `cwd` and discovered context, then verifies the parent
 * conversation still works afterward.
 */
function ChildSession() {
	useSandbox(
		bash(() => new Bash({ fs: new InMemoryFs(), network: { dangerouslyAllowFullInternetAccess: true } })),
	);
	useTool({
		name: 'child-session',
		description: 'Exercise harness.task() child conversations and verify context discovery.',
		harness: true,
		async run({ harness }) {
			const results: Record<string, boolean> = {};
			await harness.shell('mkdir -p /home/user/task-workspace');
			await harness.shell(
				'echo "You are a task agent. Always respond with the prefix [TASK]." > /home/user/task-workspace/AGENTS.md',
			);
			const taskResult = await harness.task('Say hello. Keep it very brief.', {
				cwd: '/home/user/task-workspace',
			});
			results['task returns result'] = taskResult.text.length > 0;
			results['task discovers context'] = taskResult.text.includes('[TASK]');
			const parentResult = await harness.prompt('What is 1 + 1? Reply with just the number.');
			results['parent works after task'] = parentResult.text.includes('2');
			return { results, allPassed: Object.values(results).every(Boolean) };
		},
	});
	return 'When asked to run a demo, call the `child-session` tool and report its result.';
}

export default defineAgent(ChildSession, { model: 'anthropic/claude-sonnet-4-6' });
