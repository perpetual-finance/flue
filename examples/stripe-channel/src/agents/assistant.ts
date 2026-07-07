'use agent';
import { type AgentProps, defineAgent, useTool } from '@flue/runtime';
import { getCustomerSummary, parseStripeCustomerInstanceId } from '../channels/stripe.ts';

function Assistant({ id }: AgentProps) {
	useTool(getCustomerSummary(parseStripeCustomerInstanceId(id)));
	return 'Review the completed Checkout event and summarize any billing follow-up that is needed.';
}

export default defineAgent(Assistant, { model: 'anthropic/claude-haiku-4-5' });
