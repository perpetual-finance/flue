'use agent';

/**
 * The terminal-failure case: this agent function throws when it renders, so
 * every durable submission sent to it fails. The bridge in `app.ts` captures
 * the failure as a Sentry exception (via the `submission_settled` event with
 * outcome `failed`, plus the failed operation's `operation` event).
 */
export default function boom() {
	throw new Error('intentional explosion for the Sentry demo');
}
