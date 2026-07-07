'use agent';
import { type AgentProps, defineAgent, useTool } from '@flue/runtime';
import { channel, retrieveConversation } from '../channels/intercom.ts';

function Assistant({ id }: AgentProps) {
	const conversation = channel.parseConversationKey(id);
	useTool(retrieveConversation(conversation));
	return 'Help with the inbound Intercom conversation. Retrieve the current conversation when more context is needed.';
}

export default defineAgent(Assistant, { model: 'anthropic/claude-haiku-4-5' });
