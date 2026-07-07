'use agent';
import { defineAgent } from '@flue/runtime';

function CloudflareBinding() {
	return 'You process direct requests using a Cloudflare Workers AI binding.';
}

export default defineAgent(CloudflareBinding, { model: 'cloudflare/@cf/moonshotai/kimi-k2.6' });
