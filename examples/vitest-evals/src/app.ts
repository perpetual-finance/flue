import { Hono } from 'hono';
import serviceStatus from './agents/service-status.ts';

const app = new Hono();
app.route('/agents/service-status', serviceStatus.route());

export default app;
