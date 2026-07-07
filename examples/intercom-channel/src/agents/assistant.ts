'use agent';
import { defineAgent, useInitialData, useTool } from '@flue/runtime';
import * as v from 'valibot';
import { retrieveConversation } from '../channels/intercom.ts';

const input = v.object({
	workspaceId: v.string(),
	conversationId: v.string(),
});

function Assistant() {
	const data = useInitialData<v.InferOutput<typeof input>>();
	if (!data) throw new Error('This agent is created by the Intercom channel dispatch.');
	useTool(retrieveConversation(data));
	return 'Help with the inbound Intercom conversation. Retrieve the current conversation when more context is needed.';
}

export default defineAgent(Assistant, { model: 'anthropic/claude-haiku-4-5', input });
