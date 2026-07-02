'use agent';
import { defineAction, defineAgent, registerProvider } from '@flue/runtime';

// Brand-new provider IDs for local OpenAI-compatible servers register at
// module scope, so the agent works the same under `vite dev` and
// `flue run src/agents/with-registered-provider.ts`.
registerProvider('ollama', {
	api: 'openai-completions',
	baseUrl: 'http://localhost:11434/v1',
});

const providerSmoke = defineAction({
	name: 'provider-smoke',
	description: 'Verify a session can be created against the registered provider.',
	async run({ harness }) {
		const session = await harness.session();
		return { ok: true, hasSession: typeof session === 'object' };
	},
});

export default defineAgent(() => ({
	model: 'ollama/llama3.1:8b',
	instructions: 'When asked to run a demo, call the `provider-smoke` action and report its result.',
	actions: [providerSmoke],
}));
