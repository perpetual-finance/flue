'use agent';
import { getSandbox } from '@cloudflare/sandbox';
import { defineAgent, defineAgentProfile } from '@flue/runtime';
import { cloudflareSandbox } from '@flue/runtime/cloudflare';

interface Env {
	Sandbox: Parameters<typeof getSandbox>[0];
}

const assistant = defineAgentProfile({
	instructions: 'You complete task requests submitted directly to this agent.',
});

export default defineAgent<Env>(({ id, env }) => ({
	profile: assistant,
	sandbox: cloudflareSandbox(getSandbox(env.Sandbox, id)),
}));
