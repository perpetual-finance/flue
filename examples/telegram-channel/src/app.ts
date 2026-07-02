import { Hono } from 'hono';
import assistant from './agents/assistant.ts';
import { channel } from './channels/telegram.ts';

const app = new Hono();

app.route('/agents/assistant', assistant.route());
app.route('/channels/telegram', channel.route());

export default app;
