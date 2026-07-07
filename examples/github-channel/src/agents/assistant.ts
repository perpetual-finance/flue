'use agent';
import { defineAgent, useInitialData, useTool } from '@flue/runtime';
import * as v from 'valibot';
import { commentOnIssue } from '../channels/github.ts';

const input = v.object({
	owner: v.string(),
	repo: v.string(),
	issueNumber: v.number(),
	openedBy: v.string(),
	title: v.string(),
});

function Assistant() {
	const data = useInitialData<v.InferOutput<typeof input>>();
	if (!data) throw new Error('This agent is created by the GitHub channel dispatch.');
	useTool(commentOnIssue(data));
	return `Review the issue and post a concise triage comment when appropriate. "${data.title}" was opened by ${data.openedBy}.`;
}

export default defineAgent(Assistant, { model: 'anthropic/claude-haiku-4-5', input });
