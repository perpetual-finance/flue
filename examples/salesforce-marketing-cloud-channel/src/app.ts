import { Hono } from 'hono';
import assistant from './agents/assistant.ts';
import { channel } from './channels/salesforce-marketing-cloud.ts';

const app = new Hono();

app.route('/agents/assistant', assistant.route());
app.route('/channels/salesforce-marketing-cloud', channel.route());

export default app;
