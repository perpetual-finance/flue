import { cloudflare } from '@cloudflare/vite-plugin';
import { flue } from '@flue/vite';
import { defineConfig } from 'vite';

export default defineConfig({
	plugins: [flue(), cloudflare()],
});
