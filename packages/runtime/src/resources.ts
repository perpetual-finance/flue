/**
 * Dynamic resources: tools, skills, and subagents may be declared
 * conditionally (`if (cond) useSkill(s)`), so the set the model can use
 * changes across renders. The runtime never rewrites the presentation
 * surfaces the model already read (the system prompt's skill catalog, the
 * task tool's roster) — those stay frozen on a durable BASELINE snapshot.
 * Instead, every render's declared set is diffed against the durable
 * LAST-NARRATED snapshot and the delta is appended as a `resources` signal,
 * so the transcript records exactly when each resource appeared,
 * disappeared, or changed. Compaction rebaselines: the post-compaction
 * prompt snapshots the then-current sets and the delta bookkeeping before
 * it stops mattering.
 *
 * This module is the pure core: snapshot types (shared with the durable
 * `resource_snapshot` record), the diff, and the signal-body rendering.
 */

/**
 * One resource as the model sees it named. `schema` only appears on tool
 * entries: a canonical JSON-schema digest of the input schema — tracked so
 * schema changes count as updates, but never reprinted in signals (the live
 * schema reaches the model natively in the request's tools array).
 */
export interface ResourceEntry {
	name: string;
	description?: string;
	schema?: string;
}

/** One declared tool: a {@link ResourceEntry} whose description is required. */
export interface ToolResourceEntry extends ResourceEntry {
	description: string;
}

/** The declared resource sets of one render, in declaration order. */
export interface ResourceSnapshot {
	skills: ResourceEntry[];
	tools: ToolResourceEntry[];
	subagents: ResourceEntry[];
}

export type ResourceKind = 'skill' | 'tool' | 'subagent';

export interface ResourceKindDelta {
	kind: ResourceKind;
	added: ResourceEntry[];
	removed: string[];
	updated: ResourceEntry[];
}

/**
 * Diff two snapshots by resource name. Returns one delta per kind that
 * actually changed — an empty array means the model's view is current.
 * An entry counts as updated when its description (or, for tools, its
 * schema digest) changed.
 */
export function diffResourceSnapshots(
	previous: ResourceSnapshot,
	next: ResourceSnapshot,
): ResourceKindDelta[] {
	const deltas: ResourceKindDelta[] = [];
	const kinds: Array<{ kind: ResourceKind; previous: ResourceEntry[]; next: ResourceEntry[] }> = [
		{ kind: 'skill', previous: previous.skills, next: next.skills },
		{ kind: 'tool', previous: previous.tools, next: next.tools },
		{ kind: 'subagent', previous: previous.subagents, next: next.subagents },
	];
	for (const { kind, previous: before, next: after } of kinds) {
		const beforeByName = new Map(before.map((entry) => [entry.name, entry]));
		const afterNames = new Set(after.map((entry) => entry.name));
		const added = after.filter((entry) => !beforeByName.has(entry.name));
		const removed = before.filter((entry) => !afterNames.has(entry.name)).map((e) => e.name);
		const updated = after.filter((entry) => {
			const existing = beforeByName.get(entry.name);
			return existing !== undefined && !resourceEntryEquals(existing, entry);
		});
		if (added.length > 0 || removed.length > 0 || updated.length > 0) {
			deltas.push({ kind, added, removed, updated });
		}
	}
	return deltas;
}

function resourceEntryEquals(a: ResourceEntry, b: ResourceEntry): boolean {
	return a.description === b.description && a.schema === b.schema;
}

const KIND_LABELS: Record<ResourceKind, { singular: string; plural: string; roster: string }> = {
	skill: { singular: 'skill', plural: 'skills', roster: 'All available skills' },
	tool: { singular: 'tool', plural: 'tools', roster: 'All available tools' },
	// Subagents are "agents" everywhere the model sees them (the task tool's
	// roster vocabulary), so the signals use the same word.
	subagent: { singular: 'agent', plural: 'agents', roster: 'All available agents' },
};

/**
 * Render one kind's delta as the signal body the model reads: added entries
 * as catalog-shape lines, removals and updates as factual one-liners, and
 * the current roster (names only) last so a chain of deltas always ends in
 * an unambiguous snapshot. Tool updates are name-only by design — the new
 * description/schema reaches the model natively in the tools array.
 */
export function renderResourceSignalBody(delta: ResourceKindDelta, roster: string[]): string {
	const { singular, plural, roster: rosterLabel } = KIND_LABELS[delta.kind];
	const lines: string[] = [];
	if (delta.added.length > 0) {
		lines.push(delta.added.length === 1 ? `New ${singular} available:` : `New ${plural} available:`);
		for (const entry of delta.added) lines.push(catalogLine(entry));
	}
	for (const name of delta.removed) {
		lines.push(`The ${singular} "${name}" is no longer available.`);
	}
	for (const entry of delta.updated) {
		if (delta.kind === 'tool') {
			lines.push(`The tool "${entry.name}" was updated.`);
		} else {
			lines.push(`The ${singular} "${entry.name}" was updated:`, catalogLine(entry));
		}
	}
	lines.push(`${rosterLabel}: ${roster.join(', ')}`);
	return lines.join('\n');
}

function catalogLine(entry: ResourceEntry): string {
	return entry.description ? `- **${entry.name}** — ${entry.description}` : `- **${entry.name}**`;
}
