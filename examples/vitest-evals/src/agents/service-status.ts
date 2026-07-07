'use agent';
import { defineAgent, useMessageMetadata, useTool } from '@flue/runtime';
import * as v from 'valibot';

const MODEL = 'anthropic/claude-haiku-4-5';

function ServiceStatus() {
	// Message metadata is agent-authored: attach the usage/model the eval
	// harness reads off the reply (see src/evals/harness.ts).
	useMessageMetadata('finish', (event) => ({ usage: event.usage, model: MODEL }));
	useTool({
		name: 'get_service_status',
		description: 'Look up the current operational status for a service.',
		input: v.object({ service: v.string() }),
		run: async ({ data }) => `${data.service}: operational`,
	});
	return 'Use the service status tool before answering questions about system health.';
}

export default defineAgent(ServiceStatus, { model: MODEL });
