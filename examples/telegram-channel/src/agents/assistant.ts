'use agent';
import { defineAgent, useInitialData, useTool } from '@flue/runtime';
import * as v from 'valibot';
import { postMessage } from '../channels/telegram.ts';

const chatData = v.object({
	type: v.literal('chat'),
	chatId: v.number(),
	messageThreadId: v.optional(v.number()),
	directMessagesTopicId: v.optional(v.number()),
	chatTitle: v.optional(v.string()),
});
const businessChatData = v.object({
	type: v.literal('business-chat'),
	businessConnectionId: v.string(),
	chatId: v.number(),
	messageThreadId: v.optional(v.number()),
	directMessagesTopicId: v.optional(v.number()),
	chatTitle: v.optional(v.string()),
});
const input = v.variant('type', [chatData, businessChatData]);

function Assistant() {
	const data = useInitialData<v.InferOutput<typeof input>>();
	if (!data) throw new Error('This agent is created by the Telegram channel dispatch.');
	useTool(postMessage(data));
	const chatTitle = data.chatTitle ? ` ("${data.chatTitle}")` : '';
	return `Reply concisely in the bound Telegram conversation${chatTitle}.`;
}

export default defineAgent(Assistant, { model: 'anthropic/claude-haiku-4-5', input });
