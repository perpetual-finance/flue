'use agent';
import { defineAgent, useSandbox, useTool } from '@flue/runtime';
import { local } from '@flue/runtime/node';

const sentinelKey = '__FLUE_LOCAL_SMOKE_SENTINEL__';

function LocalEnvSmoke() {
	useSandbox(local({ env: { CUSTOM_VAR: 'visible-to-sandbox' } }));
	useTool({
		name: 'local-env-smoke',
		description: 'Verify the local() sandbox environment allowlist and shell behavior.',
		harness: true,
		async run({ harness }) {
			const previous = process.env[sentinelKey];
			process.env[sentinelKey] = 'leaked';
			try {
				const results: Record<string, boolean> = {};
				const tmpDir = `/tmp/flue-local-env-smoke-${Date.now()}`;
				results['shell pwd matches process.cwd()'] =
					(await harness.shell('pwd')).stdout.trim() === process.cwd();
				await harness.shell(`mkdir -p ${tmpDir}`);
				await harness.shell(`echo "hello world" > ${tmpDir}/hello.txt`);
				results['shell read file'] =
					(await harness.shell(`cat ${tmpDir}/hello.txt`)).stdout.trim() === 'hello world';
				results['exec non-zero exit'] = (await harness.shell('exit 7')).exitCode === 7;
				results['PATH inherited via default allowlist'] =
					(await harness.shell('echo "$PATH"')).stdout.trim().length > 0;
				results['explicit env var visible'] =
					(await harness.shell('echo "$CUSTOM_VAR"')).stdout.trim() === 'visible-to-sandbox';
				results['sentinel host env var NOT leaked'] =
					(await harness.shell(`echo "$${sentinelKey}"`)).stdout.trim() === '';
				await harness.shell(`rm -rf ${tmpDir}`);
				return { results, allPassed: Object.values(results).every(Boolean) };
			} finally {
				if (previous === undefined) delete process.env[sentinelKey];
				else process.env[sentinelKey] = previous;
			}
		},
	});
	return 'When asked to run a demo, call the `local-env-smoke` tool and report its result.';
}

export default defineAgent(LocalEnvSmoke, { model: 'anthropic/claude-haiku-4-5' });
