'use agent';
import { defineAgent, useInitialData, useTool } from '@flue/runtime';
import * as v from 'valibot';
import { postMessage } from '../channels/linear.ts';

const input = v.variant('type', [
	v.object({
		type: v.literal('agent-session'),
		agentSessionId: v.string(),
		issueTitle: v.optional(v.string()),
	}),
	v.object({
		type: v.literal('issue'),
		issueId: v.string(),
		threadCommentId: v.optional(v.string()),
		issueTitle: v.optional(v.string()),
	}),
]);

function Assistant() {
	const data = useInitialData<v.InferOutput<typeof input>>();
	if (!data) throw new Error('This agent is created by the Linear channel dispatch.');
	useTool(postMessage(data));
	const issueTitle = data.issueTitle ? ` on "${data.issueTitle}"` : '';
	return `Reply concisely in the bound Linear conversation${issueTitle}.`;
}

export default defineAgent(Assistant, { model: 'anthropic/claude-haiku-4-5', input });
