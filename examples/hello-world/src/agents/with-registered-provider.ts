'use agent';
import { defineAgent, registerProvider, useTool } from '@flue/runtime';

// Brand-new provider IDs for local OpenAI-compatible servers register at
// module scope, so the agent works the same under `vite dev` and
// `flue run src/agents/with-registered-provider.ts`.
registerProvider('ollama', {
	api: 'openai-completions',
	baseUrl: 'http://localhost:11434/v1',
});

function WithRegisteredProvider() {
	useTool({
		name: 'provider-smoke',
		description: 'Verify a session can be created against the registered provider.',
		harness: true,
		async run({ harness }) {
			const session = await harness.session();
			return { ok: true, hasSession: typeof session === 'object' };
		},
	});
	return 'When asked to run a demo, call the `provider-smoke` tool and report its result.';
}

export default defineAgent(WithRegisteredProvider, { model: 'ollama/llama3.1:8b' });
