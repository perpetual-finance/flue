import { cloudflare } from '@cloudflare/vite-plugin';
import { flue } from '@flue/vite';
import { defineConfig } from 'vite';

// flue() must come before cloudflare(): it prepares the generated Worker
// entry and the merged wrangler config that the Cloudflare plugin consumes
// while Vite resolves this config. The target is auto-detected from the
// presence of cloudflare() in the plugin array.
export default defineConfig({
	plugins: [flue(), cloudflare()],
});
