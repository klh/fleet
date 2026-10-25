// scripts/ensure-shims.ts — the native ensureShims step (W771.1): writes the
// coord/work/dispatch/fleet-tracker/oracle PATH shims into the shim bin.
// Shared by sync-harness.ts (shims ride the sync publication) and the install
// plan runner (standalone --step ensureShims). Transactional: temp + rename
// per shim, symlink shims are refused, a mid-write failure restores the
// previous wrappers.
import {
	existsSync,
	lstatSync,
	mkdirSync,
	readFileSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { basename, join } from "node:path";
import type { StepContext, StepResult } from "./install/install-run.ts";

export const SHIM_NAMES = [
	"coord",
	"work",
	"dispatch",
	"fleet-tracker",
	"oracle",
	// W918.5: PATH-stable copilot launcher (bin/copilot.ts) — the npm shim
	// under nvm needs node on PATH, which launchd/lane contexts lack (W626).
	"copilot",
];

const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;

/** dispatch wraps scripts/dispatch-next.ts; the rest wrap the bin dir. */
export function shimTarget(prefix: string, name: string): string {
	return name === "dispatch"
		? join(prefix, "scripts/dispatch-next.ts")
		: join(prefix, "bin", `${name}.ts`);
}

export function shimScript(prefix: string, name: string): string {
	return `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(shimTarget(prefix, name))} "$@"\n`;
}

export interface PlannedShim {
	path: string;
	old: string | null;
}

/** Collect current shim contents for rollback; symlink shims are a fork. */
export function planShims(shimBin: string): PlannedShim[] {
	mkdirSync(shimBin, { recursive: true });
	const shims: PlannedShim[] = [];
	for (const name of SHIM_NAMES) {
		const path = join(shimBin, name);
		if (existsSync(path) && lstatSync(path).isSymbolicLink())
			throw new Error(`Refusing symlink shim: ${name}`);
		shims.push({
			path,
			old: existsSync(path) ? readFileSync(path, "utf8") : null,
		});
	}
	return shims;
}

/** Write every shim via temp + publish; temps are cleaned up on failure. */
export function writeShims(
	prefix: string,
	shims: PlannedShim[],
	publish: (source: string, destination: string) => void = renameSync,
): void {
	const temporaryShims: string[] = [];
	try {
		for (const shim of shims) {
			const temp = `${shim.path}.${crypto.randomUUID()}.tmp`;
			temporaryShims.push(temp);
			writeFileSync(temp, shimScript(prefix, basename(shim.path)), {
				mode: 0o755,
			});
			publish(temp, shim.path);
		}
	} finally {
		for (const temp of temporaryShims) rmSync(temp, { force: true });
	}
}

/** Restore the collected pre-write contents (rollback leg of a failure). */
export function restoreShims(shims: PlannedShim[]): void {
	for (const shim of shims) {
		if (shim.old === null) rmSync(shim.path, { force: true });
		else writeFileSync(shim.path, shim.old, { mode: 0o755 });
	}
}

/** The install-plan step: (re)write the PATH shims against the live prefix. */
export async function ensureShims(ctx: StepContext): Promise<StepResult> {
	if (!existsSync(shimTarget(ctx.prefix, "coord"))) {
		return {
			status: "failed",
			note: `no harness at ${ctx.prefix} (bin/coord.ts missing) — run the syncHarness step first or the shims would dangle`,
		};
	}
	const shims = planShims(ctx.shimBin);
	writeShims(ctx.prefix, shims);
	return {
		status: "ok",
		note: `wrote ${shims.length} PATH shims into ${ctx.shimBin} → ${ctx.prefix}`,
	};
}

if (import.meta.main) {
	const argument = (name: string) => {
		const index = process.argv.indexOf(name);
		return index < 0 ? undefined : process.argv[index + 1];
	};
	const prefix = argument("--prefix"),
		shimBin = argument("--shim-bin");
	if (!prefix || !shimBin)
		throw new Error("ensure-shims requires --prefix and --shim-bin");
	console.log(
		(
			await ensureShims({
				repo: "",
				prefix,
				shimBin,
				llmHome: "",
				dryRun: false,
				yes: true,
				json: false,
				verbose: false,
			})
		).note,
	);
}
