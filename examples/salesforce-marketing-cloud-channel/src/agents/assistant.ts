'use agent';
import { type AgentProps, defineAgent, useTool } from '@flue/runtime';
import { retrieveCallback } from '../channels/salesforce-marketing-cloud.ts';
import { parseEmailEventInstanceId } from '../salesforce-marketing-cloud-email.ts';

function Assistant({ id }: AgentProps) {
	const email = parseEmailEventInstanceId(id);
	useTool(retrieveCallback(email));
	return 'Review the inbound Salesforce Marketing Cloud email lifecycle event. Retrieve the configured ENS callback when callback status or delivery configuration is relevant.';
}

export default defineAgent(Assistant, { model: 'anthropic/claude-haiku-4-5' });
