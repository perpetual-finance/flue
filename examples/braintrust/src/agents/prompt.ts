'use agent';
import { defineAgent } from '@flue/runtime';

/** A plain prompting agent: each turn shows up as an `llm` span in Braintrust. */
export default defineAgent(() => ({
	model: 'anthropic/claude-haiku-4-5',
	instructions: 'Write a one-sentence welcome for the person named in each message.',
}));
