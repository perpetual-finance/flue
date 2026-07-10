'use agent';
import { type AgentRouteHandler, defineAgent, useModel, useTool } from '@flue/runtime';

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

function WithRequest() {
	useModel('anthropic/claude-haiku-4-5');
	useTool({
		name: 'greet',
		description: 'Ask the harness conversation for a five-word hello.',
		harness: true,
		async run({ harness }) {
			const { text } = await harness.prompt('Say hello in 5 words.');
			return { text };
		},
	});
	return 'When asked to run a demo, call the `greet` tool and report its result.';
}

export default defineAgent(WithRequest);
