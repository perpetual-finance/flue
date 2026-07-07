'use agent';
import { bash, defineAgent, useSandbox, useTool } from '@flue/runtime';
import { Bash, InMemoryFs } from 'just-bash';

function WithCustomBash() {
	const fs = new InMemoryFs();
	useSandbox(bash(() => new Bash({ fs })));
	useTool({
		name: 'prove-custom-bash',
		description: 'Write and read a file inside the customized virtual sandbox.',
		harness: true,
		async run({ harness }) {
			const session = await harness.session();
			await session.shell('echo "custom bash succeeded" > proof.txt');
			return { text: (await session.shell('cat proof.txt')).stdout.trim() };
		},
	});
	return 'When asked to run the demo, call the `prove-custom-bash` action and report its result.';
}

export default defineAgent(WithCustomBash, { model: 'anthropic/claude-haiku-4-5' });
