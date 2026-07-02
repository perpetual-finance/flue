'use agent';
import { bash, defineAction, defineAgent } from '@flue/runtime';
import { Bash, InMemoryFs } from 'just-bash';

const proveCustomBash = defineAction({
	name: 'prove-custom-bash',
	description: 'Write and read a file inside the customized virtual sandbox.',
	async run({ harness }) {
		const session = await harness.session();
		await session.shell('echo "custom bash succeeded" > proof.txt');
		return { text: (await session.shell('cat proof.txt')).stdout.trim() };
	},
});

export default defineAgent(() => {
	const fs = new InMemoryFs();
	return {
		sandbox: bash(() => new Bash({ fs })),
		model: 'anthropic/claude-haiku-4-5',
		instructions:
			'When asked to run the demo, call the `prove-custom-bash` action and report its result.',
		actions: [proveCustomBash],
	};
});
