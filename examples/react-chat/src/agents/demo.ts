'use agent';
/**
 * Formerly `src/workflows/demo.ts` (`defineWorkflow` with a code-first `run`).
 * Workflows are gone: a background job is now an agent whose deterministic
 * code lives in a model-callable action, and a "run" is one conversation.
 * The UI triggers it by sending a message; the scripted model calls the
 * `run_demo` action, whose progress logs and structured result stream back
 * through the conversation like any other tool call.
 */
import {
	fauxAssistantMessage,
	fauxText,
	fauxToolCall,
	registerFauxProvider,
} from '@earendil-works/pi-ai/compat';
import { defineAction, defineAgent } from '@flue/runtime';
import * as v from 'valibot';

const runDemo = defineAction({
	name: 'run_demo',
	description: 'Run the demo background job: logs progress and returns a structured receipt.',
	input: v.object({ requestedAt: v.string() }),
	async run({ log, input }) {
		log.info('demo action started', { requestedAt: input.requestedAt });
		await new Promise((resolve) => setTimeout(resolve, 500));
		log.info('demo action received input', { input });
		await new Promise((resolve) => setTimeout(resolve, 500));
		log.info('demo action completed');
		return { ok: true, requestedAt: input.requestedAt };
	},
});

export default defineAgent(() => {
	// Scripted model so the demo runs fully offline: one tool call into the
	// action, then a closing text reply.
	const faux = registerFauxProvider({
		api: 'react-chat-demo',
		provider: 'react-chat-demo',
		models: [{ id: 'demo' }],
	});
	faux.setResponses([
		fauxAssistantMessage(
			fauxToolCall('run_demo', { requestedAt: new Date().toISOString() }),
			{ stopReason: 'toolUse' },
		),
		fauxAssistantMessage(fauxText('Demo action completed.')),
	]);
	return {
		model: 'react-chat-demo/demo',
		instructions: 'When asked to run the demo, call the run_demo action and report its result.',
		actions: [runDemo],
	};
});
