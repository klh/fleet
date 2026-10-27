// src/run-cli.ts — runCli(): spawn ['bun', bin, ...args] -> {code,out,err}
// (W1135.1.3). Verbatim semantics of the audited idiom (the ~150 per-file
// run()/workIn() helpers: Bun.spawnSync with piped streams, toString'd
// output, cwd/env overrides spread over process.env).
export interface CliResult {
	/** Child exit code. */
	code: number;
	/** Child stdout (utf8). */
	out: string;
	/** Child stderr (utf8). */
	err: string;
}

export interface RunCliOpts {
	/** Working directory for the child (default: inherit). */
	cwd?: string;
	/** Env overrides spread over process.env (default: process.env). */
	env?: Record<string, string | undefined>;
}

/** Run a bun script to completion: ["bun", bin, ...args]. Sync. */
export function runCli(
	bin: string,
	args: string[] = [],
	opts: RunCliOpts = {},
): CliResult {
	const p = Bun.spawnSync(["bun", bin, ...args], {
		cwd: opts.cwd,
		env: opts.env ? { ...process.env, ...opts.env } : process.env,
		stdout: "pipe",
		stderr: "pipe",
	});
	return {
		code: p.exitCode,
		out: p.stdout.toString(),
		err: p.stderr.toString(),
	};
}
