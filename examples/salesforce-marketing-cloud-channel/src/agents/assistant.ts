'use agent';
import { defineAgent, useInitialData, useTool } from '@flue/runtime';
import * as v from 'valibot';
import { retrieveCallback } from '../channels/salesforce-marketing-cloud.ts';

const input = v.object({
	callbackId: v.string(),
	mid: v.string(),
	eid: v.string(),
	jobId: v.string(),
	batchId: v.string(),
	listId: v.string(),
	subscriberId: v.string(),
});

function Assistant() {
	const data = useInitialData<v.InferOutput<typeof input>>();
	if (!data) {
		throw new Error(
			'This agent is created by the Salesforce Marketing Cloud channel dispatch.',
		);
	}
	useTool(retrieveCallback(data));
	return 'Review the inbound Salesforce Marketing Cloud email lifecycle event. Retrieve the configured ENS callback when callback status or delivery configuration is relevant.';
}

export default defineAgent(Assistant, { model: 'anthropic/claude-haiku-4-5', input });
