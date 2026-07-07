import type { Skill } from '../types.ts';
import { requireRenderFrame } from './frame.ts';

/**
 * Mount a skill in the agent's catalog. Skills are progressive disclosure:
 * every mounted skill costs one always-present catalog line (name +
 * description) in the system prompt, and the model pulls the full
 * instructions on demand with the framework's `activate_skill` tool — the
 * briefing arrives as the tool result, so the prompt prefix never changes.
 * Supporting files stay lazy until explicitly read.
 *
 * Accepts a `SkillReference` (a `SKILL.md` import `with { type: 'skill' }`,
 * or `defineSkill(...)`) or a bare `{ name, description }` catalog entry for
 * content the model reads from the workspace itself:
 *
 * ```ts
 * import triageSkill from '../skills/triage/SKILL.md' with { type: 'skill' };
 *
 * function ReproducePhase({ check, onComplete }: PhaseProps) {
 *   useSkill(triageSkill);
 *   return 'Activate the `triage` skill before starting this phase.';
 * }
 * ```
 *
 * Always-on skill content needs no hook — import the markdown
 * `with { type: 'markdown' }` and pass it to `useInstruction()`. Mounts are
 * static like everything else: a skill mounted by a phase hook is
 * cataloged on every turn; the hook's instruction says when to
 * activate it. Duplicate names across the render fail fast.
 */
export function useSkill(skill: Skill): void {
	const frame = requireRenderFrame('useSkill');
	if (!skill || typeof skill !== 'object' || Array.isArray(skill)) {
		throw new Error(
			"[flue] useSkill() requires a skill: a SKILL.md import with { type: 'skill' }, a defineSkill(...) value, or a { name, description } catalog entry.",
		);
	}
	const { name, description } = skill as Partial<Skill>;
	if (typeof name !== 'string' || name.trim().length === 0) {
		throw new Error('[flue] useSkill() skill name must be a non-empty string.');
	}
	if (typeof description !== 'string' || description.trim().length === 0) {
		throw new Error(
			`[flue] useSkill() skill "${name}" needs a non-empty description — the catalog line is how the model decides when to activate it.`,
		);
	}
	if (frame.skills.some((mounted) => mounted.name === name)) {
		throw new Error(
			`[flue] useSkill() mounted the skill name "${name}" twice in one render. Each skill mounts once; share it from a single custom hook.`,
		);
	}
	frame.skills.push(skill);
}
