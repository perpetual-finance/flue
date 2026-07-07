'use agent';
import { type AgentProps, defineAgent, useTool } from '@flue/runtime';
import { emailIdFromInstanceId, retrieveReceivedEmail } from '../channels/resend.ts';

function Assistant({ id }: AgentProps) {
	const emailId = emailIdFromInstanceId(id);
	useTool(retrieveReceivedEmail(emailId));
	return 'Review the inbound support email. Retrieve the complete email when its body or headers are needed.';
}

export default defineAgent(Assistant, { model: 'anthropic/claude-haiku-4-5' });
