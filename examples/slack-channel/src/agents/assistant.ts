'use agent';
import { defineAgent, useInitialData, useTool } from '@flue/runtime';
import * as v from 'valibot';
import { replyInThread } from '../channels/slack.ts';

const input = v.object({
	channelId: v.string(),
	threadTs: v.string(),
	startedBy: v.optional(v.string()),
	startedAt: v.pipe(v.string(), v.isoTimestamp()),
});

function Assistant() {
	const data = useInitialData<v.InferOutput<typeof input>>();
	if (!data) throw new Error('This agent is created by the Slack channel dispatch.');
	useTool(replyInThread(data));
	const startedBy = data.startedBy ? ` by <@${data.startedBy}>` : '';
	return `Reply in the bound Slack thread when appropriate. This conversation was started${startedBy} at ${data.startedAt}.`;
}

export default defineAgent(Assistant, { model: 'anthropic/claude-haiku-4-5', input });
