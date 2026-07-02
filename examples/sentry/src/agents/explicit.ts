'use agent';
import { defineAction, defineAgent } from '@flue/runtime';

/**
 * The non-fatal case: the handler reports errors with `log.error` and keeps
 * going. Each `log.error` becomes a Sentry capture — an exception when an
 * `error` attribute is present, a message otherwise — while the conversation
 * completes normally.
 */
const explicit = defineAction({
	name: 'explicit',
	description:
		'Report recoverable errors with log.error (with and without an error attribute) and continue.',
	run({ log }) {
		try {
			throw new TypeError('downstream service returned an unexpected shape');
		} catch (error) {
			log.error('flaky downstream call failed; continuing with fallback', {
				error,
				service: 'fictional-pricing-api',
				retriable: false,
			});
		}
		log.error('low-confidence model output rejected', {
			confidence: 0.21,
			threshold: 0.5,
			action: 'fell back to deterministic path',
		});
		return { ok: true, fallbackUsed: true };
	},
});

export default defineAgent(() => ({
	model: 'anthropic/claude-haiku-4-5',
	instructions: 'When asked to run the demo, call the `explicit` action and report its result.',
	actions: [explicit],
}));
