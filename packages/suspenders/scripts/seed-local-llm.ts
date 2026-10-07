// seed-local-llm.ts — CONVERGE belt-owned runtime code copies (W422.6.1).
// install.sh seeded the local-llm home only when absent ("runtime copy is
// source of truth"), so a pre-W507 registry-emit.ts survived every install:
// `registry-emit.ts tier` was a usage error, tier.json never emitted, and
// llm-keepwarm + the swarm ran the failsafe <=4GB set. Code copies now
// converge on hash mismatch — the pre-refresh copy is backed up to
// <file>.before-refresh — while operator-owned config (belt.env,
// routing-policy.yaml) stays seeded-only-when-absent, never clobbered.
import { copyFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

// W465 one-source: these runtime files are belt/bin-owned code (litellm
// target + the registry/router/admission/spawn kit); the installer converges
// them. The registry itself is a re-export in some runtimes — converged back
// to belt/bin on mismatch, with the pre-refresh copy preserved as backup.
export const BELT_CODE_FILES = [
	"litellm-target.ts",
	"registry.ts",
	"router-shim.ts",
	"router-core.ts",
	"admission.ts",
	"prompt-fingerprint.ts",
	"registry-emit.ts",
	"router-condense.ts",
	"spawner.ts",
	"spawn-admission.ts",
];

export type ConvergeResult = {
	seeded: string[];
	refreshed: string[];
	current: string[];
};

// Idempotent convergence of one runtime home against a belt/bin source dir.
export function convergeBeltCode(
	home: string,
	beltBin: string,
): ConvergeResult {
	mkdirSync(home, { recursive: true });
	const result: ConvergeResult = { seeded: [], refreshed: [], current: [] };
	for (const file of BELT_CODE_FILES) {
		const src = join(beltBin, file);
		const dst = join(home, file);
		if (!existsSync(src)) throw new Error(`missing belt/bin source: ${src}`);
		if (!existsSync(dst)) {
			copyFileSync(src, dst);
			result.seeded.push(file);
		} else if (readFileSync(dst).equals(readFileSync(src))) {
			result.current.push(file);
		} else {
			copyFileSync(dst, `${dst}.before-refresh`);
			copyFileSync(src, dst);
			result.refreshed.push(file);
		}
	}
	return result;
}

// W507: the tier choice is machine config — every install re-emits the tier
// manifest the swarm supervisor and llm-keepwarm both read. A copy that still
// rejects `tier` degrades to false (install.sh prints the stale note), never
// a failed install.
export async function emitTierManifest(home: string): Promise<boolean> {
	const child = Bun.spawn(
		[
			process.execPath,
			join(home, "registry-emit.ts"),
			"tier",
			"--out",
			join(home, "tier.json"),
		],
		{
			env: { ...process.env, BELT_TIER: "minimal" },
			stdout: "ignore",
			stderr: "pipe",
		},
	);
	const timeout = setTimeout(() => child.kill(), 10_000);
	try {
		return (await child.exited) === 0;
	} finally {
		clearTimeout(timeout);
	}
}

export function report(result: ConvergeResult, home: string): void {
	for (const file of result.current) console.log(`= ${join(home, file)} up to date`);
	for (const file of result.seeded) console.log(`+ ${join(home, file)} (from belt/bin)`);
	for (const file of result.refreshed) {
		console.log(`↻ ${join(home, file)} converged from belt/bin (prior copy → ${file}.before-refresh)`);
	}
	if (result.refreshed.length > 0)
		console.log("→ restart com.suspenders.local-llm to activate refreshed code");
}

// Bun strips `--` before process.argv (W250): parse argv[2:] directly.
async function main(argv: string[]): Promise<number> {
	let home = `${process.env.HOME}/.claude/local-llm`;
	let beltBin = "";
	for (let i = 0; i < argv.length; i++) {
		if (argv[i] === "--home") home = argv[++i] ?? "";
		if (argv[i] === "--belt") beltBin = argv[++i] ?? "";
	}
	if (!home || !beltBin) {
		console.error("usage: bun seed-local-llm.ts --home DIR --belt BELT_BIN_DIR");
		return 2;
	}
	const result = convergeBeltCode(home, beltBin);
	report(result, home);
	const emitted = await emitTierManifest(home);
	if (emitted) console.log(`+ ${join(home, "tier.json")} (BELT_TIER=minimal)`);
	else
		console.log(
			"→ tier manifest emission skipped (registry-emit.ts rejected tier — inspect home)",
		);
	return 0;
}

if (import.meta.main) process.exit(await main(process.argv.slice(2)));
