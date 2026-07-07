'use agent';
import { defineAgent, useInitialData, useTool } from '@flue/runtime';
import * as v from 'valibot';
import { retrievePage } from '../channels/notion.ts';

const input = v.object({
	pageId: v.string(),
});

function Assistant() {
	const data = useInitialData<v.InferOutput<typeof input>>();
	if (!data) throw new Error('This agent is created by the Notion channel dispatch.');
	useTool(retrievePage(data.pageId));
	return 'Review the Notion page change. Retrieve the current page when its properties are needed.';
}

export default defineAgent(Assistant, { model: 'anthropic/claude-haiku-4-5', input });
