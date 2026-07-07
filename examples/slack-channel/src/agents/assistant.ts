'use agent';
import { type AgentProps, defineAgent, useTool } from '@flue/runtime';
import { channel, replyInThread } from '../channels/slack.ts';

function Assistant({ id }: AgentProps) {
	useTool(replyInThread(channel.parseConversationKey(id)));
	return 'Reply in the bound Slack thread when appropriate.';
}

export default defineAgent(Assistant, { model: 'anthropic/claude-haiku-4-5' });
