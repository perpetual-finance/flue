import { defineTool } from '@flue/runtime';
import * as v from 'valibot';

/**
 * Demo domain tools for the support desk. Every `run()` is a stub: it logs
 * nothing and returns descriptive text instead of touching a real ticketing
 * or payments system. None of these tools are phase-aware — phase guarding
 * happens at the mount site in `agents/support.ts`, via `guarded()` from
 * `machine.ts`, so these definitions stay reusable and easy to read on
 * their own.
 */

export const draftReply = defineTool({
	name: 'draft_reply',
	description: 'Draft a reply to the customer for review before sending.',
	input: v.object({ body: v.pipe(v.string(), v.minLength(1)) }),
	run: ({ input }) => `Draft saved: "${input.body}"`,
});

export const draftEscalation = defineTool({
	name: 'draft_escalation',
	description: 'Draft an internal escalation summary for a specialist team.',
	input: v.object({
		team: v.pipe(v.string(), v.minLength(1)),
		summary: v.pipe(v.string(), v.minLength(1)),
	}),
	run: ({ input }) => `Escalation drafted for ${input.team}: "${input.summary}"`,
});

export const proposeRefund = defineTool({
	name: 'propose_refund',
	description:
		'Propose a refund amount and reason for operator approval. Does not issue the refund.',
	input: v.object({
		amountCents: v.pipe(v.number(), v.integer(), v.minValue(1)),
		reason: v.pipe(v.string(), v.minLength(1)),
	}),
	run: ({ input }) =>
		`Refund of $${(input.amountCents / 100).toFixed(2)} proposed for approval: "${input.reason}"`,
});

export const commitApprovedRefund = defineTool({
	name: 'commit_approved_refund',
	description: 'Issue a refund that an operator has already approved by reference.',
	input: v.object({
		amountCents: v.pipe(v.number(), v.integer(), v.minValue(1)),
		approvalReference: v.pipe(v.string(), v.minLength(1)),
	}),
	run: ({ input }) =>
		`Refund of $${(input.amountCents / 100).toFixed(2)} issued (approval ${input.approvalReference}).`,
});

export const sendReply = defineTool({
	name: 'send_reply',
	description: 'Send the drafted reply to the customer.',
	input: v.object({ body: v.pipe(v.string(), v.minLength(1)) }),
	run: ({ input }) => `Reply sent: "${input.body}"`,
});

export const offerCredit = defineTool({
	name: 'offer_credit',
	description: 'Offer the customer account credit as a retention incentive.',
	input: v.object({ amountCents: v.pipe(v.number(), v.integer(), v.minValue(1)) }),
	run: ({ input }) => `Offered $${(input.amountCents / 100).toFixed(2)} account credit.`,
});
