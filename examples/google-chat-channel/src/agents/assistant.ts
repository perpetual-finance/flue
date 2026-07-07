'use agent';
import { defineAgent, useInitialData, useTool } from '@flue/runtime';
import * as v from 'valibot';
import { postMessage } from '../channels/google-chat.ts';

const input = v.object({
	space: v.string(),
	thread: v.optional(v.string()),
});

function Assistant() {
	const data = useInitialData<v.InferOutput<typeof input>>();
	if (!data) throw new Error('This agent is created by the Google Chat channel dispatch.');
	useTool(postMessage(data));
	return 'Reply concisely in the bound Google Chat conversation.';
}

export default defineAgent(Assistant, { model: 'anthropic/claude-haiku-4-5', input });
