import { Hono } from 'hono';
import assistant from './agents/assistant.ts';
import { channel } from './channels/slack.ts';

const app = new Hono();

app.route('/agents/assistant', assistant.route());
app.route('/channels/slack', channel.route());

export default app;
