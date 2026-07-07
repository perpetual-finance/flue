'use agent';
import { type AgentProps, defineAgent, useTool } from '@flue/runtime';
import { channel, postMessage } from '../channels/discord.ts';

function Assistant({ id }: AgentProps) {
	useTool(postMessage(channel.parseConversationKey(id)));
	return 'Post a concise answer to the bound Discord destination.';
}

export default defineAgent(Assistant, { model: 'anthropic/claude-haiku-4-5' });
