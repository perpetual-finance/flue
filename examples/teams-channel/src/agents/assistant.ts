'use agent';
import { defineAgent, useInitialData, useTool } from '@flue/runtime';
import * as v from 'valibot';
import { postMessage } from '../channels/teams.ts';

const input = v.object({
	serviceUrl: v.string(),
	conversationId: v.string(),
	botId: v.string(),
	threadId: v.optional(v.string()),
	conversationName: v.optional(v.string()),
});

function Assistant() {
	const data = useInitialData<v.InferOutput<typeof input>>();
	if (!data) throw new Error('This agent is created by the Microsoft Teams channel dispatch.');
	useTool(postMessage(data));
	const conversationName = data.conversationName ? ` "${data.conversationName}"` : '';
	return `Reply concisely in the bound Microsoft Teams conversation${conversationName}.`;
}

export default defineAgent(Assistant, { model: 'anthropic/claude-haiku-4-5', input });
