'use agent';
import { defineAgent, defineAgentProfile } from '@flue/runtime';

const editor = defineAgentProfile({
	name: 'editor',
	instructions: 'Rewrite the supplied sentence in a clearer, shorter form.',
});

/** A delegating agent: `session.task` delegations show up as `task` spans in Braintrust. */
export default defineAgent(() => ({
	model: 'anthropic/claude-haiku-4-5',
	instructions:
		'Delegate every rewrite request to the `editor` subagent with the task tool, then return its result verbatim.',
	subagents: [editor],
}));
