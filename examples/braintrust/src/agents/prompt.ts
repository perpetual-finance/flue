'use agent';

/** A plain prompting agent: each turn shows up as an `llm` span in Braintrust. */
export default function prompt() {
	return {
		model: 'anthropic/claude-haiku-4-5',
		instruction: 'Write a one-sentence welcome for the person named in each message.',
	};
}
