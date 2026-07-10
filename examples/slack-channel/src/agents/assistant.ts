'use agent';
import { defineAgent, useInitialData, useModel, useTool } from '@flue/runtime';
import * as v from 'valibot';
import { replyInThread } from '../channels/slack.ts';

export const initialDataSchema = v.object({
	channelId: v.string(),
	threadTs: v.string(),
	startedBy: v.optional(v.string()),
	startedAt: v.pipe(v.string(), v.isoTimestamp()),
});

function Assistant() {
	useModel('anthropic/claude-haiku-4-5');
	const data = useInitialData<v.InferOutput<typeof initialDataSchema>>();
	if (!data) throw new Error('This agent is created by the Slack channel dispatch.');
	useTool(replyInThread(data));
	const startedBy = data.startedBy ? ` by <@${data.startedBy}>` : '';
	return `Reply in the bound Slack thread when appropriate. This conversation was started${startedBy} at ${data.startedAt}.`;
}

export default defineAgent(Assistant);
