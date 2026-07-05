'use agent';
import { addTool, defineTool } from '@flue/runtime';
import * as v from 'valibot';

const lookup = defineTool({
	name: 'lookup_weather',
	description: 'Look up current weather for a city.',
	input: v.object({ city: v.string() }),
	run: async ({ input }) => `${input.city}: sunny, 72 F`,
});

/** A tool-using agent: tool calls show up as `tool` spans in Braintrust. */
export default function tools() {
	addTool(lookup);
	return {
		model: 'anthropic/claude-haiku-4-5',
		instruction: 'Use the weather tool to report the current weather for the requested city.',
	};
}
