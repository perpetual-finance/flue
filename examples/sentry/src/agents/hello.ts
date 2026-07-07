'use agent';
import { defineAgent, useTool } from '@flue/runtime';

/**
 * The success case: logs at info level and returns a value. Produces no
 * Sentry traffic — only `log.error` and terminal failures are captured.
 */
function Hello() {
	useTool({
		name: 'hello',
		description: 'Log an info line and return a greeting. The no-Sentry-traffic success case.',
		run({ log }) {
			log.info('hello action starting');
			return { greeting: 'hello from flue' };
		},
	});
	return 'When asked to run the demo, call the `hello` action and report its result.';
}

export default defineAgent(Hello, { model: 'anthropic/claude-haiku-4-5' });
