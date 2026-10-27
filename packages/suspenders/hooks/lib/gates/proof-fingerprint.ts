// proof-fingerprint.ts — W2181: the verify.py port (saranyan/agent-relay
// borrow #2). A proof harness fingerprints the workspace BEFORE and AFTER
// every verification run — one sha256 over the tree content each side — and
// a tree that changed mid-run banks as UNKNOWN, never passed. The same law
// covers the unreadable case: a tree whose content cannot be read is also
// unknown (fail-closed — an unfingerprintable tree never proves itself
// unchanged), so a planted or half-written workspace can never bank a pass.
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

// never folded into a workspace fingerprint: VCS plumbing, dependency
// closures (a proof scratch shares the repo's node_modules by symlink), and
// fleet runtime state.
const UNFINGERPRINTED = new Set([
	".git",
	"node_modules",
	".worktrees",
	".fleet",
]);

export type FingerprintVerdict = "unchanged" | "changed" | "unknown";

/** One sha256 over the workspace: sorted repo-relative paths, each folded
 *  with the hash of its file bytes (order-independent by construction, but
 *  sorted anyway so the stream is deterministic). `paths` names explicit
 *  repo-relative files; without it the whole tree is walked, skipping the
 *  UNFINGERPRINTED set and symlinks. Returns null when ANY covered path
 *  cannot be read — callers must bank UNKNOWN, never a pass. */
export const workspaceFingerprint = (
	root: string,
	paths?: readonly string[],
): string | null => {
	const h = createHash("sha256");
	const fold = (rel: string): boolean => {
		try {
			h.update(rel);
			h.update("\0");
			h.update(
				createHash("sha256")
					.update(readFileSync(join(root, rel)))
					.digest(),
			);
			return true;
		} catch {
			return false;
		}
	};
	const walk = (rel: string): boolean => {
		let entries: { name: string; dir: boolean; file: boolean }[];
		try {
			entries = readdirSync(join(root, rel), { withFileTypes: true })
				.filter((e) => !UNFINGERPRINTED.has(e.name) && !e.isSymbolicLink())
				.map((e) => ({ name: e.name, dir: e.isDirectory(), file: e.isFile() }))
				.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
		} catch {
			return false;
		}
		for (const { name, dir, file } of entries) {
			const child = rel ? `${rel}/${name}` : name;
			if (dir ? !walk(child) : file ? !fold(child) : false) return false;
		}
		return true;
	};
	if (paths) {
		for (const rel of [...paths].sort()) if (!fold(rel)) return null;
		return h.digest("hex");
	}
	return walk("") ? h.digest("hex") : null;
};

/** verify.py verdict: identical before/after hashes = unchanged; any content
 *  change or unreadable tree = unknown — the run's result cannot bank as a
 *  pass. `changed` and `unknown` are both never-pass verdicts. */
export const fingerprintVerdict = (
	before: string | null,
	after: string | null,
): FingerprintVerdict =>
	before === null || after === null
		? "unknown"
		: before === after
			? "unchanged"
			: "changed";
