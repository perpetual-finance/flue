'use agent';
import { type AgentProps, defineAgent, useTool } from '@flue/runtime';
import { channel, commentOnIssue } from '../channels/github.ts';

function Assistant({ id }: AgentProps) {
	useTool(commentOnIssue(channel.parseConversationKey(id)));
	return 'Review the issue and post a concise triage comment when appropriate.';
}

export default defineAgent(Assistant, { model: 'anthropic/claude-haiku-4-5' });
