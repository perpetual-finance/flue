'use agent';
import { defineAgent, registerProvider, useModel, useTool } from '@flue/runtime';

// Brand-new provider IDs for local OpenAI-compatible servers register at
// module scope, so the agent works the same under `vite dev` and
// `flue run src/agents/with-registered-provider.ts`.
registerProvider('ollama', {
	api: 'openai-completions',
	baseUrl: 'http://localhost:11434/v1',
});

function WithRegisteredProvider() {
	useModel('ollama/llama3.1:8b');
	useTool({
		name: 'provider-smoke',
		description: 'Verify a prompt can be run against the registered provider.',
		harness: true,
		async run({ harness }) {
			const response = await harness.prompt('Reply with exactly one word: ok');
			return { ok: true, hasResponse: response.text.length > 0 };
		},
	});
	return 'When asked to run a demo, call the `provider-smoke` tool and report its result.';
}

export default defineAgent(WithRegisteredProvider);
