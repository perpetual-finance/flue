'use agent';
import { type AgentRouteHandler, defineAction, defineAgent } from '@flue/runtime';

/**
 * The `route` named export keeps its meaning on the new surface: middleware
 * that `.route()` applies to every HTTP request for this agent's routes.
 */
export const route: AgentRouteHandler = async (c, next) => {
	const request = c.req.raw;
	console.log('[with-request] method:', request.method);
	console.log('[with-request] url:', request.url);
	console.log('[with-request] user-agent:', request.headers.get('user-agent'));
	console.log('[with-request] raw body:', await request.clone().text());
	const ip =
		request.headers.get('cf-connecting-ip') ??
		request.headers.get('x-forwarded-for')?.split(',')[0]?.trim();
	console.log('[with-request] ip:', ip);
	if (!request.headers.get('authorization')) return c.json({ error: 'unauthorized' }, 401);
	await next();
};

const greet = defineAction({
	name: 'greet',
	description: 'Ask a child session for a five-word hello.',
	async run({ harness }) {
		const session = await harness.session();
		const { text } = await session.prompt('Say hello in 5 words.');
		return { text };
	},
});

export default defineAgent(() => ({
	model: 'anthropic/claude-haiku-4-5',
	instructions: 'When asked to run a demo, call the `greet` action and report its result.',
	actions: [greet],
}));
