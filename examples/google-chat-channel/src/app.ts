import { Hono } from 'hono';
import assistant from './agents/assistant.ts';
import { channel } from './channels/google-chat.ts';

const app = new Hono();

app.route('/agents/assistant', assistant.route());
app.route('/channels/google-chat', channel.route());

export default app;
