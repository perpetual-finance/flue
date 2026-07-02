import { Hono } from 'hono';
import assistant from './agents/assistant.ts';

const app = new Hono();
app.route('/agents/assistant', assistant.route());

export default app;
