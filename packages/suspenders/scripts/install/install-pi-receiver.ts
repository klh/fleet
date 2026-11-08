// scripts/install/install-pi-receiver.ts — W2863 face (a) install face: sync
// the fleet-receiver pi extension from the repo source
// (pi-extensions/fleet-receiver/) into the pi agent home
// (~/.pi/agent/extensions/). The receiver is the consult-plane delivery
// seam for a CLI with no fleet hooks; install owns the installed copy the
// way install owns the statusline's models.json (W2861): repo source is the
// truth, the installed copy is a sync target, user edits there are
// downstream of the repo and get overwritten by the next install.
import { copyFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";

export interface PiReceiverResult {
	status: "ok" | "planned";
	/** synced = copied, current = already byte-identical, planned = dry-run. */
	action: "synced" | "current" | "planned";
	note: string;
}

const EXT_DIR = "extensions/fleet-receiver";
const EXT_FILE = "index.ts";

export function installPiReceiver(
	options: { home?: string; piHome?: string; dryRun?: boolean } = {},
): PiReceiverResult {
	const home = options.home ?? process.env.HOME ?? "";
	const src = join(
		import.meta.dir,
		"..",
		"..",
		"pi-extensions",
		"fleet-receiver",
		EXT_FILE,
	);
	const dst = join(
		options.piHome ?? join(home, ".pi/agent"),
		EXT_DIR,
		EXT_FILE,
	);
	if (options.dryRun) {
		return {
			status: "planned",
			action: "planned",
			note: `would sync ${dst} (dry-run)`,
		};
	}
	mkdirSync(dirname(dst), { recursive: true });
	if (
		existsSync(dst) &&
		readFileSync(dst, "utf8") === readFileSync(src, "utf8")
	) {
		return { status: "ok", action: "current", note: `${dst} already current` };
	}
	copyFileSync(src, dst);
	return { status: "ok", action: "synced", note: `synced ${src} → ${dst}` };
}

if (import.meta.main) {
	const r = installPiReceiver({ dryRun: process.argv.includes("--dry-run") });
	console.log(`${r.action}: ${r.note}`);
}
