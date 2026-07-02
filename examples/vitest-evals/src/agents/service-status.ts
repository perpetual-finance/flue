'use agent';
import { defineAgent, defineTool } from '@flue/runtime';
import * as v from 'valibot';

const getServiceStatus = defineTool({
	name: 'get_service_status',
	description: 'Look up the current operational status for a service.',
	input: v.object({ service: v.string() }),
	run: async ({ input }) => `${input.service}: operational`,
});

export default defineAgent(() => ({
	model: 'anthropic/claude-haiku-4-5',
	instructions: 'Use the service status tool before answering questions about system health.',
	tools: [getServiceStatus],
}));
