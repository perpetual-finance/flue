import { Hono } from 'hono';
import assistant from './agents/assistant.ts';
import { channel } from './channels/intercom.ts';

const app = new Hono();

app.route('/agents/assistant', assistant.route());
app.route('/channels/intercom', channel.route());

export default app;
