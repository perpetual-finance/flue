'use agent';
import { bash, defineAgent, useSandbox, useTool } from '@flue/runtime';
import { Bash, InMemoryFs } from 'just-bash';

function FsTest() {
	useSandbox(bash(() => new Bash({ fs: new InMemoryFs() })));
	useTool({
		name: 'fs-test',
		description: 'Verify shell and model file access inside a custom bash sandbox.',
		harness: true,
		async run({ harness }) {
			const session = await harness.session();
			const results: Record<string, boolean> = {};
			await session.shell('echo "Seeded workspace instructions" > AGENTS.md');
			results['read workspace file'] = (await session.shell('cat AGENTS.md')).stdout.trim().length > 0;
			await session.prompt(
				'Create a file called "hello.txt" in the current directory. Its contents should be exactly: Hello from the agent',
			);
			results['llm write file'] =
				(await session.shell('cat hello.txt')).stdout.trim() === 'Hello from the agent';
			await session.prompt(
				'Read the file AGENTS.md, then overwrite it with exactly this content: MODIFIED BY AGENT',
			);
			results['llm overwrite workspace file'] =
				(await session.shell('cat AGENTS.md')).stdout.trim() === 'MODIFIED BY AGENT';
			await session.shell('echo "shell content" > shell-created.txt');
			results['shell write file'] =
				(await session.shell('cat shell-created.txt')).stdout.trim() === 'shell content';
			return { results, allPassed: Object.values(results).every(Boolean) };
		},
	});
	return 'When asked to run a demo, call the `fs-test` tool and report its result.';
}

export default defineAgent(FsTest, { model: 'anthropic/claude-sonnet-4-6' });
