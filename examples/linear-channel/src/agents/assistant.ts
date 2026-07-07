'use agent';
import { type AgentProps, defineAgent, useTool } from '@flue/runtime';
import { channel, postMessage } from '../channels/linear.ts';

function Assistant({ id }: AgentProps) {
	useTool(postMessage(channel.parseConversationKey(id)));
	return 'Reply concisely in the bound Linear conversation.';
}

export default defineAgent(Assistant, { model: 'anthropic/claude-haiku-4-5' });
