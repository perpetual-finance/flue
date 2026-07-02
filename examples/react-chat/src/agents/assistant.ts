'use agent';
import { fauxAssistantMessage, fauxText, registerFauxProvider } from '@earendil-works/pi-ai/compat';
import { defineAgent } from '@flue/runtime';

// The 'use agent' directive registers this module with the app (its file
// basename is the durable identity); app.ts exposes it over HTTP by mounting
// `assistant.route()` at `/api/agents/assistant`. An optional `route` named
// export would attach middleware (e.g. auth) to every mounted route.
export default defineAgent(() => {
	const faux = registerFauxProvider({
		api: 'react-chat-example',
		provider: 'react-chat-example',
		models: [{ id: 'assistant' }],
	});
	faux.setResponses([
		(context) => {
			const input = context.messages.at(-1);
			const text =
				input?.role === 'user'
					? typeof input.content === 'string'
						? input.content
						: input.content.map((block) => (block.type === 'text' ? block.text : '')).join('')
					: '';
			return fauxAssistantMessage(fauxText(`You said: ${text}`));
		},
	]);
	return {
		model: 'react-chat-example/assistant',
		instructions: 'Reply briefly and helpfully.',
	};
});
