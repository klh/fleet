// scripts/install-report-tail.ts — W899: the install tail proves the W892
// verb live (owner: "make damn sure"). One table, one implementation: the
// tail CALLS `work report` — through the installed prefix's PATH shim, which
// is the (b) acceptance door — and its output prints as the install's final
// section. Never a re-implementation of the table here.
import { existsSync } from "node:fs";
import { join } from "node:path";
import {
	latestTag,
	machineVersionHint,
	spawnGitRunner,
} from "./lib/release-version.ts";

export interface ReportTailCtx {
	prefix: string;
	shimBin: string;
}

export interface ReportTailResult {
	ok: boolean;
	/** which door ran the verb — the PATH shim (the install door) or the prefix bin fallback */
	source: "shim" | "prefix";
	/** the table text (stdout), "" when the verb died */
	out: string;
	/** stderr text for the failure note */
	err: string;
}

/** spawn injection point (tests pass a fake runner). */
export type TailRunner = (argv: string[]) => {
	code: number;
	out: string;
	err: string;
};

/** The real runner: capture stdout+stderr, no inherit. */
export const processRunner: TailRunner = (argv) => {
	const p = Bun.spawnSync(argv, { stdout: "pipe", stderr: "pipe" });
	return {
		code: p.exitCode,
		out: new TextDecoder().decode(p.stdout ?? new Uint8Array()),
		err: new TextDecoder().decode(p.stderr ?? new Uint8Array()),
	};
};

/** The report tail: shim first (acceptance (b)), prefix bin as the fallback
 *  door (fresh installs before ensureShims / shim-less profiles). */
export function reportTail(
	ctx: ReportTailCtx,
	run: TailRunner = processRunner,
): ReportTailResult {
	const shim = join(ctx.shimBin, "work");
	const argv =
		existsSync(shim) && existsSync(ctx.prefix)
			? [shim, "report"]
			: [process.execPath, join(ctx.prefix, "bin", "work.ts"), "report"];
	const r = run(argv);
	return {
		ok: r.code === 0,
		source: argv[0] === shim ? "shim" : "prefix",
		out: r.out.trim(),
		err: r.err.trim(),
	};
}

/** W1303.6: the one-version evidence line for the install tail — the
 *  machine stack.json pin rendered against the repo's latest release tag.
 *  Render-only: the 0600 conf is operator-owned, nothing is written. */
export function stackVersionTail(repo: string): string {
	return machineVersionHint(
		latestTag(spawnGitRunner(repo))?.slice(1) ?? undefined,
	).line;
}
