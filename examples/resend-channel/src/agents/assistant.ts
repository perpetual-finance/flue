'use agent';
import { defineAgent, useInitialData, useTool } from '@flue/runtime';
import * as v from 'valibot';
import { retrieveReceivedEmail } from '../channels/resend.ts';

const input = v.object({
	emailId: v.string(),
	from: v.string(),
	subject: v.string(),
	receivedAt: v.pipe(v.string(), v.isoTimestamp()),
});

function Assistant() {
	const data = useInitialData<v.InferOutput<typeof input>>();
	if (!data) throw new Error('This agent is created by the Resend channel dispatch.');
	useTool(retrieveReceivedEmail(data.emailId));
	return `Review the inbound support email, handling an email from ${data.from} about ${data.subject} received at ${data.receivedAt}. Retrieve the complete email when its body or headers are needed.`;
}

export default defineAgent(Assistant, { model: 'anthropic/claude-haiku-4-5', input });
