'use agent';
import { defineAgent, useInitialData, useTool } from '@flue/runtime';
import * as v from 'valibot';
import { postMessage } from '../channels/twilio.ts';

const input = v.variant('type', [
	v.object({ type: v.literal('address'), address: v.string(), participant: v.string() }),
	v.object({
		type: v.literal('messaging-service'),
		messagingServiceSid: v.string(),
		participant: v.string(),
	}),
]);

function Assistant() {
	const data = useInitialData<v.InferOutput<typeof input>>();
	if (!data) throw new Error('This agent is created by the Twilio channel dispatch.');
	useTool(postMessage(data));
	return 'Reply concisely in the bound Twilio conversation.';
}

export default defineAgent(Assistant, { model: 'anthropic/claude-haiku-4-5', input });
