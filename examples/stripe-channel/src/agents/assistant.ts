'use agent';
import { defineAgent, useInitialData, useTool } from '@flue/runtime';
import * as v from 'valibot';
import { getCustomerSummary } from '../channels/stripe.ts';

const input = v.object({
	customerId: v.string(),
	accountId: v.optional(v.string()),
	context: v.optional(v.string()),
});

function Assistant() {
	const data = useInitialData<v.InferOutput<typeof input>>();
	if (!data) throw new Error('This agent is created by the Stripe channel dispatch.');
	useTool(getCustomerSummary(data));
	return 'Review the completed Checkout event and summarize any billing follow-up that is needed.';
}

export default defineAgent(Assistant, { model: 'anthropic/claude-haiku-4-5', input });
