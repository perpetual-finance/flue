'use agent';
import { defineAgent, useInitialData, useTool } from '@flue/runtime';
import * as v from 'valibot';
import { retrieveTicket } from '../channels/zendesk.ts';

const input = v.object({
	accountId: v.string(),
	ticketId: v.string(),
});

function Assistant() {
	const data = useInitialData<v.InferOutput<typeof input>>();
	if (!data) throw new Error('This agent is created by the Zendesk channel dispatch.');
	useTool(retrieveTicket(data));
	return 'Review the inbound Zendesk ticket event. Retrieve the current ticket when more context is needed.';
}

export default defineAgent(Assistant, { model: 'anthropic/claude-haiku-4-5', input });
