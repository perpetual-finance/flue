'use agent';
import { defineAgent } from '@flue/runtime';

/**
 * The terminal-failure case: this agent's initializer throws, so every
 * durable submission sent to it fails. The bridge in `app.ts` captures the
 * failure as a Sentry exception (via the `submission_settled` event with
 * outcome `failed`, plus the failed operation's `operation` event).
 */
export default defineAgent(() => {
	throw new Error('intentional explosion for the Sentry demo');
});
