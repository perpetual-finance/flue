'use agent';
import { defineAgent, useInitialData, useTool } from '@flue/runtime';
import * as v from 'valibot';
import { postMessage } from '../channels/messenger.ts';

const input = v.object({
	pageId: v.string(),
	participant: v.variant('type', [
		v.object({ type: v.literal('page-scoped-id'), id: v.string() }),
		v.object({ type: v.literal('user-ref'), id: v.string() }),
	]),
});

function Assistant() {
	const data = useInitialData<v.InferOutput<typeof input>>();
	if (!data) throw new Error('This agent is created by the Messenger channel dispatch.');
	useTool(postMessage(data));
	return 'Reply concisely in the bound Facebook Messenger conversation.';
}

export default defineAgent(Assistant, { model: 'anthropic/claude-haiku-4-5', input });
