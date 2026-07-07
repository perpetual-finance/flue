'use agent';
import { type AgentProps, defineAgent, useTool } from '@flue/runtime';
import { parseShopifyOrderInstanceId, retrieveOrder } from '../channels/shopify.ts';

function Assistant({ id }: AgentProps) {
	const order = parseShopifyOrderInstanceId(id);
	useTool(retrieveOrder(order));
	return 'Review the newly created Shopify order and summarize any fulfillment or payment follow-up.';
}

export default defineAgent(Assistant, { model: 'anthropic/claude-haiku-4-5' });
