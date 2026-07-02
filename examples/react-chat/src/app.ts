/**
 * The route map: every agent is mounted explicitly under /api, preserving the
 * URL shape the SDK/React client's `{ name, id }` addressing expects
 * (`/api/agents/<name>/<id>`). Static UI assets built by vite.config.ui.ts
 * are served from dist/client (paths relative to the process cwd — run the
 * server from this directory).
 */
import { registerProvider } from '@flue/runtime';
import { serveStatic } from '@hono/node-server/serve-static';
import { Hono } from 'hono';
import assistant from './agents/assistant.ts';
import demo from './agents/demo.ts';
import helper from './agents/helper.ts';

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

app.route('/api/agents/assistant', assistant.route());
app.route('/api/agents/demo', demo.route());
app.route('/api/agents/helper', helper.route());

app.use('*', serveStatic({ root: './dist/client' }));
app.get('*', serveStatic({ path: './dist/client/index.html' }));

export default app;
