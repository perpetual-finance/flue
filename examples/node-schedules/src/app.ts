import { dispatch } from '@flue/runtime';
import { Cron } from 'croner';
import { Hono } from 'hono';
import scheduledAgent from './agents/scheduled.ts';

const app = new Hono();
app.route('/agents/scheduled', scheduledAgent.route());

// A plain in-process cron (croner) delivers a durable schedule signal to a
// persistent agent instance. `dispatch()` resolves the agent by definition —
// no HTTP round-trip — and the fixed `id` means every firing lands in the
// same `daily-summary` conversation.
new Cron(
	process.env.AGENT_SCHEDULE ?? '0 9 * * *',
	{
		protect: true,
		timezone: process.env.SCHEDULE_TIMEZONE ?? 'UTC',
		catch: (error) => console.error('Scheduled agent admission failed', error),
	},
	async () => {
		await dispatch(scheduledAgent, {
			id: 'daily-summary',
			message: {
				kind: 'signal',
				type: 'schedule',
				body: 'Review recent activity and prepare the daily summary.',
				attributes: { scheduledAt: new Date().toISOString() },
			},
		});
	},
);

export default app;
