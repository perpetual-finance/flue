'use agent';
import { defineAction, defineAgent } from '@flue/runtime';

/**
 * The success case: logs at info level and returns a value. Produces no
 * Sentry traffic — only `log.error` and terminal failures are captured.
 */
const hello = defineAction({
	name: 'hello',
	description: 'Log an info line and return a greeting. The no-Sentry-traffic success case.',
	run({ log }) {
		log.info('hello action starting');
		return { greeting: 'hello from flue' };
	},
});

export default defineAgent(() => ({
	model: 'anthropic/claude-haiku-4-5',
	instructions: 'When asked to run the demo, call the `hello` action and report its result.',
	actions: [hello],
}));
