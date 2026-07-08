'use agent';
import { Daytona } from '@daytona/sdk';
import { defineAgent, useSandbox, useTool } from '@flue/runtime';
import { daytona } from '../sandboxes/daytona';

function WithSandbox() {
	useSandbox({
		// Lazy, per the SandboxFactory contract: constructing this object is
		// cheap; the expensive Daytona sandbox creation happens once, inside
		// createSessionEnv(), at initialization — never on a re-render.
		async createSessionEnv(options) {
			const client = new Daytona({ apiKey: process.env.DAYTONA_API_KEY });
			const sandbox = await client.create();
			return daytona(sandbox).createSessionEnv(options);
		},
	});
	useTool({
		name: 'sandbox-test',
		description: 'Exercise shell primitives inside a remote Daytona sandbox.',
		harness: true,
		async run({ harness }) {
			const uname = await harness.shell('uname -a');
			const unameOk = uname.exitCode === 0 && uname.stdout.includes('Linux');
			await harness.shell('echo "hello from sandbox" > /tmp/test.txt');
			const fileOk = (await harness.shell('cat /tmp/test.txt')).stdout.trim() === 'hello from sandbox';
			const compound = await harness.shell('echo step1 && echo step2');
			const compoundOk = compound.stdout.includes('step1') && compound.stdout.includes('step2');
			const pipe = await harness.shell('echo -e "a\\nb\\nc" | wc -l');
			const pipeOk = pipe.exitCode === 0 && pipe.stdout.trim() === '3';
			await harness.shell('echo "redirected content" > /tmp/redirect-test.txt');
			const redirectOk =
				(await harness.shell('cat /tmp/redirect-test.txt')).stdout.trim() === 'redirected content';
			await harness.shell(
				'mkdir -p /tmp/pipe-test && touch /tmp/pipe-test/a.txt /tmp/pipe-test/b.txt /tmp/pipe-test/c.txt',
			);
			const findWc = await harness.shell('find /tmp/pipe-test -type f | wc -l');
			const findWcOk = findWc.exitCode === 0 && findWc.stdout.trim() === '3';
			return {
				unameOk,
				fileOk,
				compoundOk,
				pipeOk,
				redirectOk,
				findWcOk,
				allPassed: unameOk && fileOk && compoundOk && pipeOk && redirectOk && findWcOk,
			};
		},
	});
	return 'When asked to run a demo, call the `sandbox-test` tool and report its result.';
}

export default defineAgent(WithSandbox, { model: 'anthropic/claude-sonnet-4-6' });
