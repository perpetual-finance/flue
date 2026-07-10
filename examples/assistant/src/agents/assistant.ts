'use agent';
import { env } from 'cloudflare:workers';
import { getSandbox } from '@cloudflare/sandbox';
import { type AgentProps, defineAgent, useModel, useSandbox } from '@flue/runtime';
import { cloudflareSandbox } from '@flue/runtime/cloudflare';

interface Env {
	Sandbox: Parameters<typeof getSandbox>[0];
}

function Assistant({ id }: AgentProps) {
	useModel('cloudflare/@cf/moonshotai/kimi-k2.6');
	const { Sandbox } = env as unknown as Env;
	useSandbox(cloudflareSandbox(getSandbox(Sandbox, id)));
	return 'You complete task requests submitted directly to this agent.';
}

export default defineAgent(Assistant);
