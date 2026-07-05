'use agent';
import { fauxAssistantMessage, fauxText, registerFauxProvider } from '@earendil-works/pi-ai/compat';
import { defineAgent } from '@flue/runtime';

// The 'use agent' directive registers this module with the app (its file
// basename is the durable identity); app.ts exposes it over HTTP by mounting
// `agent(assistant).route()` at `/api/agents/assistant`. An optional `route`
// named export would attach middleware (e.g. auth) to every mounted route.

// The scripted (faux, keyless) model this offline example runs against.
// Module scope, not the agent body: the agent function is a render that may
// re-run, so one-time setup lives outside it.
const faux = registerFauxProvider({
	api: 'react-chat-example',
	provider: 'react-chat-example',
	models: [{ id: 'assistant' }],
});
// Faux responses are consumed one per model call, so the echo re-queues
// itself: one scripted reply per user message, indefinitely.
const echo: Parameters<typeof faux.setResponses>[0][number] = (context) => {
	faux.appendResponses([echo]);
	const input = context.messages.at(-1);
	const text =
		input?.role === 'user'
			? typeof input.content === 'string'
				? input.content
				: input.content.map((block) => (block.type === 'text' ? block.text : '')).join('')
			: '';
	return fauxAssistantMessage(fauxText(`You said: ${text}`));
};
faux.setResponses([echo]);

function Assistant() {
	return 'Reply briefly and helpfully.';
}

export default defineAgent(Assistant, { model: 'react-chat-example/assistant' });
