'use agent';
import { defineAgent, useModel } from '@flue/runtime';

function CloudflareBinding() {
	useModel('cloudflare/@cf/moonshotai/kimi-k2.6');
	return 'You process direct requests using a Cloudflare Workers AI binding.';
}

export default defineAgent(CloudflareBinding);
