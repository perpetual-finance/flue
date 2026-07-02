import { Hono } from 'hono';
import assistant from './agents/assistant.ts';
import { channel } from './channels/resend.ts';

const app = new Hono();

app.route('/agents/assistant', assistant.route());
app.route('/channels/resend', channel.route());

export default app;
