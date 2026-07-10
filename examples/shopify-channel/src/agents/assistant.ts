'use agent';
import { defineAgent, useInitialData, useModel, useTool } from '@flue/runtime';
import * as v from 'valibot';
import { retrieveOrder } from '../channels/shopify.ts';

export const initialDataSchema = v.object({
	shopDomain: v.string(),
	orderId: v.string(),
	orderName: v.string(),
});

function Assistant() {
	useModel('anthropic/claude-haiku-4-5');
	const data = useInitialData<v.InferOutput<typeof initialDataSchema>>();
	if (!data) throw new Error('This agent is created by the Shopify channel dispatch.');
	useTool(retrieveOrder(data));
	return `Review the newly created Shopify order ${data.orderName} and summarize any fulfillment or payment follow-up.`;
}

export default defineAgent(Assistant);
