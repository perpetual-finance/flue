'use agent';

import { defineAgent } from '@flue/runtime';

/** A plain prompting agent: each turn shows up as an `llm` span in Braintrust. */
function Prompt() {
	return 'Write a one-sentence welcome for the person named in each message.';
}

export default defineAgent(Prompt, { model: 'anthropic/claude-haiku-4-5' });
