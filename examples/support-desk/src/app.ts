import { agent } from '@flue/runtime/routing';
import { Hono } from 'hono';
import support from './agents/support.ts';

const app = new Hono();
app.route('/agents/support', agent(support).route());

export default app;
