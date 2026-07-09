'use agent';
import { defineAgent, useSubagent } from '@flue/runtime';

function Greeter() {
	return 'Write one warm, concise greeting.';
}

function WithSubagent() {
	useSubagent({
		name: 'greeter',
		description: 'Writes a short, warm greeting for a named user.',
		agent: Greeter,
	});
	return 'When asked to greet someone, delegate the greeting to the `greeter` subagent and report its greeting verbatim.';
}

export default defineAgent(WithSubagent, { model: 'anthropic/claude-sonnet-4-6' });
