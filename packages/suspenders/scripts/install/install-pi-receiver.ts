// scripts/install/install-pi-receiver.ts — W2863 face (a) install face,
// generalized by W3059: sync EVERY pi extension from the repo source
// (pi-extensions/<name>/index.ts) into the pi agent home
// (~/.pi/agent/extensions/<name>/index.ts) — fleet-receiver (consult
// plane) and qlty-on-write (the on-write qlty fmt face) today. Install
// owns the installed copies the way install owns the statusline's
// models.json (W2861): repo source is the truth, the installed copy is a
// sync target, user edits there are downstream of the repo and get
// overwritten by the next install.
import {
	copyFileSync,
	existsSync,
	mkdirSync,
	readFileSync,
	readdirSync,
	statSync,
} from "node:fs";
import { join } from "node:path";

export interface PiReceiverResult {
	status: "ok" | "planned";
	/** synced = copied, current = already byte-identical, planned = dry-run. */
	action: "synced" | "current" | "planned";
	note: string;
}

/** Per-extension row of the generalized sync (W3059). */
export interface PiExtensionSync {
	name: string;
	action: "synced" | "current" | "planned";
	dst: string;
	note: string;
}

const EXT_FILE = "index.ts";

/** Extensions with a DEDICATED installer (scripts/install/install-pi-<token>.ts)
 *  own their installed face themselves — e.g. fleet-awareness ships a BUILT
 *  entry via install-pi-awareness.ts (W3059 fix): the generic source sync
 *  must NOT copy its repo index.ts into ~/.pi (an unresolvable-import
 *  source copy shadowing the working bundle break). The generic syncer
 *  itself (install-pi-receiver.ts) is the shared face, not a claim.
 *  Token↔dir names may differ by a shared prefix (awareness ↔
 *  fleet-awareness), so the match is suffix-based either way. */
function dedicatedInstallerClaimed(name: string, installDir: string): boolean {
	let files: string[];
	try {
		files = readdirSync(installDir);
	} catch {
		return false;
	}
	const tokens = files
		.filter(
			(f) => /^install-pi-.+\.ts$/.test(f) && f !== "install-pi-receiver.ts",
		)
		.map((f) => f.slice("install-pi-".length, -".ts".length));
	return tokens.some(
		(t) => t === name || name.endsWith(`-${t}`) || t.endsWith(`-${name}`),
	);
}

/** Every repo pi extension eligible for the plain-source sync:
 *  `pi-extensions/<name>/index.ts` exists and no dedicated installer
 *  claims the face. */
export function piExtensionNames(repoDir?: string): string[] {
	const base = repoDir ?? join(import.meta.dir, "..", "..", "pi-extensions");
	const installDir = import.meta.dir;
	try {
		return readdirSync(base)
			.filter((n) => {
				const p = join(base, n);
				return (
					statSync(p).isDirectory() &&
					existsSync(join(p, EXT_FILE)) &&
					!dedicatedInstallerClaimed(n, installDir)
				);
			})
			.sort();
	} catch {
		return [];
	}
}

export function installPiExtensions(
	options: {
		home?: string;
		piHome?: string;
		dryRun?: boolean;
		repoDir?: string;
	} = {},
): PiReceiverResult & { results: PiExtensionSync[] } {
	const home = options.home ?? process.env.HOME ?? "";
	const repoDir = options.repoDir ?? join(import.meta.dir, "..", "..");
	const names = piExtensionNames(join(repoDir, "pi-extensions"));
	const results: PiExtensionSync[] = names.map((name) => {
		const src = join(repoDir, "pi-extensions", name, EXT_FILE);
		const dst = join(
			options.piHome ?? join(home, ".pi/agent"),
			"extensions",
			name,
			EXT_FILE,
		);
		if (options.dryRun) {
			return {
				name,
				action: "planned",
				dst,
				note: `would sync ${dst} (dry-run)`,
			};
		}
		mkdirSync(join(dst, ".."), { recursive: true });
		if (
			existsSync(dst) &&
			readFileSync(dst, "utf8") === readFileSync(src, "utf8")
		) {
			return { name, action: "current", dst, note: `${dst} already current` };
		}
		copyFileSync(src, dst);
		return { name, action: "synced", dst, note: `synced ${src} → ${dst}` };
	});
	if (names.length === 0) {
		return {
			status: "ok",
			action: "current",
			note: "no pi extensions in repo",
			results,
		};
	}
	if (options.dryRun) {
		return {
			status: "planned",
			action: "planned",
			note: results.map((r) => r.note).join("; "),
			results,
		};
	}
	const synced = results.filter((r) => r.action === "synced");
	return {
		status: "ok",
		action: synced.length > 0 ? "synced" : "current",
		note: results.map((r) => r.note).join("; "),
		results,
	};
}

/** W2863-compatible single-extension face (fleet-receiver only) — the
 *  consult-context suite pins planned → synced → current on it. */
export function installPiReceiver(
	options: { home?: string; piHome?: string; dryRun?: boolean } = {},
): PiReceiverResult {
	const all = installPiExtensions(options);
	const mine = all.results.find((r) => r.name === "fleet-receiver");
	if (!mine) {
		return {
			status: all.status,
			action: all.action,
			note: "fleet-receiver not present in repo pi-extensions/",
		};
	}
	return { status: all.status, action: mine.action, note: mine.note };
}

if (import.meta.main) {
	const r = installPiExtensions({ dryRun: process.argv.includes("--dry-run") });
	console.log(`${r.action}: ${r.note}`);
}
