/**
 * The route map: every agent is mounted explicitly under /api. The UI's
 * conversation URLs (`/api/agents/<name>/<id>`) are simply this app's chosen
 * layout — the client addresses whatever URL the app mounts. Static UI assets
 * built by vite.config.ui.ts are served from dist/client (paths relative to
 * the process cwd — run the server from this directory).
 */
import { registerProvider } from '@flue/runtime';
import { createAgentRouter } from '@flue/runtime/routing';
import { serveStatic } from '@hono/node-server/serve-static';
import { Hono } from 'hono';
import { Assistant } from './agents/assistant.ts';
import { Demo } from './agents/demo.ts';
import { Helper } from './agents/helper.ts';

// Wire the scripted (faux) model APIs the offline agents register in their
// initializers; helper uses a real Anthropic model and needs no entry here.
registerProvider('react-chat-example', {
	api: 'react-chat-example',
	baseUrl: '',
});
registerProvider('react-chat-demo', {
	api: 'react-chat-demo',
	baseUrl: '',
});

const app = new Hono();

app.route('/api/agents/assistant', createAgentRouter(Assistant));
app.route('/api/agents/demo', createAgentRouter(Demo));
app.route('/api/agents/helper', createAgentRouter(Helper));

app.use('*', serveStatic({ root: './dist/client' }));
app.get('*', serveStatic({ path: './dist/client/index.html' }));

export default app;
