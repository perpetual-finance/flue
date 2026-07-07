'use agent';
/**
 * Demonstrates hydrating a cf-shell `Workspace` from an R2 bucket and using a
 * skill discovered from the hydrated files. Formerly a workflow whose `run`
 * invoked the skill directly; the deterministic skill invocation now lives in
 * the model-callable `check_spam` tool below (`harness: true` gives its run
 * a child harness — `harness.session().skill(...)` works exactly as it did
 * in the workflow body):
 *
 *   curl -X POST /agents/skills-from-r2/<id> \
 *     -H 'Content-Type: application/json' \
 *     -d '{"kind": "user", "body": "Check this message for spam: CONGRATS! You won a free iPhone: http://bit.ly/xyz"}'
 *
 * then read the verdict from the conversation stream: GET /agents/skills-from-r2/<id>
 */
import { defineAgent, defineTool } from '@flue/runtime';
import * as v from 'valibot';
import {
	getDefaultWorkspace,
	getShellSandbox,
	hydrateFromBucket,
} from '../sandboxes/cloudflare-shell';

const HYDRATION_SENTINEL = '/.hydrated';

const checkSpam = defineTool({
	name: 'check_spam',
	description:
		'Classify a message as spam or not using the spam-filter skill from the hydrated knowledge base. Returns a structured verdict.',
	input: v.object({ message: v.string() }),
	output: v.object({
		spam: v.boolean(),
		confidence: v.picklist(['low', 'medium', 'high']),
		reasoning: v.string(),
	}),
	harness: true,
	async run({ harness, input }) {
		const session = await harness.session();
		const result = await session.skill('spam-filter', {
			args: { message: input.message },
			result: v.object({
				spam: v.boolean(),
				confidence: v.picklist(['low', 'medium', 'high']),
				reasoning: v.string(),
			}),
		});
		return result.data;
	},
});

// `env` carries the wrangler.jsonc bindings (KNOWLEDGE_BASE R2 bucket + LOADER).
export default defineAgent(async ({ env }) => {
	const workspace = getDefaultWorkspace();
	if (!(await workspace.exists(HYDRATION_SENTINEL))) {
		await hydrateFromBucket(workspace, env.KNOWLEDGE_BASE);
		await workspace.writeFile(HYDRATION_SENTINEL, new Date().toISOString());
	}
	return {
		sandbox: getShellSandbox({ workspace, loader: env.LOADER }),
		model: 'cloudflare/@cf/moonshotai/kimi-k2.6',
		instructions:
			'When asked whether a message is spam, call the check_spam tool with the message text and report its verdict.',
		tools: [checkSpam],
	};
});
