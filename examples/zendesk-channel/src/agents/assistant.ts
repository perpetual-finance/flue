'use agent';
import { type AgentProps, defineAgent, useTool } from '@flue/runtime';
import { channel, retrieveTicket } from '../channels/zendesk.ts';

function Assistant({ id }: AgentProps) {
	const ticket = channel.parseTicketKey(id);
	useTool(retrieveTicket(ticket));
	return 'Review the inbound Zendesk ticket event. Retrieve the current ticket when more context is needed.';
}

export default defineAgent(Assistant, { model: 'anthropic/claude-haiku-4-5' });
