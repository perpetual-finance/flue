import { flue } from '@flue/vite';
import { defineConfig } from 'vite';

export default defineConfig({
	plugins: [flue()],
	// A fixed port so the eval harness's default FLUE_BASE_URL stays stable.
	server: { port: 3583, strictPort: true },
});
