import { cloudflare } from '@cloudflare/vite-plugin';
import { flue } from '@flue/vite';
import { defineConfig } from 'vite';

// flue() must precede cloudflare(): it prepares the generated Worker entry
// and merged wrangler config the Cloudflare plugin consumes.
export default defineConfig({
	plugins: [flue(), cloudflare()],
});
