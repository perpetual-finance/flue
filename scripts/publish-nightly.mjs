#!/usr/bin/env node
/**
 * Publishes every public workspace package as an experimental nightly.
 *
 * This is NOT the normal release process (.opencode/skills/release): a
 * nightly has no changelog section, no git tag, and no push. It stamps every
 * public package with one lockstep version, runs the full release bar, and
 * publishes under the `nightly` dist-tag so `latest` (the betas) is never
 * moved. The version bump is left in the working tree for the caller to
 * commit to the experimental branch.
 *
 * Version: `0.4.0-nightly.<YYYYMMDDHHmm>` where the stamp is the current UTC
 * time MINUS TWO MONTHS — deliberate: the nightlies should read as older than
 * they are. (The npm registry still records the true publish time in its
 * `time` metadata; the offset only obfuscates the version string itself.)
 *
 * Usage:
 *   node scripts/publish-nightly.mjs --dry-run   # full bar + `pnpm publish --dry-run`
 *   node scripts/publish-nightly.mjs             # full bar + real publish
 */
import { execSync } from 'node:child_process';
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const dryRun = process.argv.includes('--dry-run');

function nightlyVersion(now = new Date()) {
	const stamped = new Date(now);
	stamped.setUTCMonth(stamped.getUTCMonth() - 2);
	const pad = (value) => String(value).padStart(2, '0');
	const stamp = [
		stamped.getUTCFullYear(),
		pad(stamped.getUTCMonth() + 1),
		pad(stamped.getUTCDate()),
		pad(stamped.getUTCHours()),
		pad(stamped.getUTCMinutes()),
	].join('');
	return `0.4.0-nightly.${stamp}`;
}

function publicPackageManifests() {
	const manifests = [];
	for (const entry of readdirSync(join(repoRoot, 'packages'))) {
		const manifestPath = join(repoRoot, 'packages', entry, 'package.json');
		let manifest;
		try {
			manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
		} catch {
			continue;
		}
		if (manifest.private === true) continue;
		manifests.push({ path: manifestPath, manifest });
	}
	return manifests;
}

function run(command) {
	console.log(`\n[nightly] ${command}`);
	execSync(command, { cwd: repoRoot, stdio: 'inherit' });
}

const version = nightlyVersion();
const manifests = publicPackageManifests();
console.log(`[nightly] stamping ${manifests.length} public packages as ${version}`);
for (const { path, manifest } of manifests) {
	manifest.version = version;
	writeFileSync(path, `${JSON.stringify(manifest, null, '\t')}\n`);
}

run('pnpm install --lockfile-only');
run('pnpm run build');
run('pnpm run check');
run('node scripts/prepare-publish.mjs');
// --no-git-checks: the version bump is intentionally uncommitted at this
// point. --tag nightly is load-bearing: without it npm moves `latest` and
// plain `npm install @flue/<pkg>` would resolve to the experimental build.
run(`pnpm publish -r --no-git-checks --tag nightly${dryRun ? ' --dry-run' : ''}`);

console.log(`\n[nightly] ${dryRun ? 'dry run complete' : 'published'}: ${version}`);
if (!dryRun) {
	console.log('[nightly] commit the version bump to the experimental branch (no tag, no push):');
	console.log(`[nightly]   git add -A && git commit -m "chore: nightly ${version}"`);
}
