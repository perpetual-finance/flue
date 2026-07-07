'use agent';
import { type AgentProps, defineAgent, useTool } from '@flue/runtime';
import { pageIdFromInstanceId, retrievePage } from '../channels/notion.ts';

function Assistant({ id }: AgentProps) {
	const pageId = pageIdFromInstanceId(id);
	useTool(retrievePage(pageId));
	return 'Review the Notion page change. Retrieve the current page when its properties are needed.';
}

export default defineAgent(Assistant, { model: 'anthropic/claude-haiku-4-5' });
