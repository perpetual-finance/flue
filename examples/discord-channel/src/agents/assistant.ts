'use agent';
import { defineAgent, useInitialData, useTool } from '@flue/runtime';
import * as v from 'valibot';
import { postMessage } from '../channels/discord.ts';

const input = v.object({
	channelId: v.string(),
	channelName: v.optional(v.string()),
});

function Assistant() {
	const data = useInitialData<v.InferOutput<typeof input>>();
	if (!data) throw new Error('This agent is created by the Discord channel dispatch.');
	useTool(postMessage(data));
	const channelName = data.channelName ? ` #${data.channelName}` : '';
	return `Post a concise answer to the bound Discord destination${channelName}.`;
}

export default defineAgent(Assistant, { model: 'anthropic/claude-haiku-4-5', input });
