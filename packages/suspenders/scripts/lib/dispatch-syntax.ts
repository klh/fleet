import { join } from "node:path";

/** Compile dependency trees without executing dispatch, hooks or graph writes. */
export function probeDispatchSyntax(
	repo: string,
	prefix: string,
): {
	ok: boolean;
	sourceBroken: boolean;
	failures: string[];
} {
	const failures: string[] = [];
	let sourceBroken = false;
	for (const [source, entry] of [
		[true, join(repo, "packages/suspenders/scripts/dispatch-next.ts")],
		[true, join(repo, "packages/suspenders/hooks/bin/fleet-loop.ts")],
		[false, join(prefix, "bin/fleet-loop.ts")],
	] as const) {
		const result = Bun.spawnSync(
			[process.execPath, "build", entry, "--target=bun", "--outfile=/dev/null"],
			{ stdout: "pipe", stderr: "pipe", timeout: 10_000 },
		);
		if (result.exitCode === 0) continue;
		sourceBroken ||= source;
		const detail = `${result.stdout.toString()}${result.stderr.toString()}`;
		failures.push(`${entry} (PARSE FAIL: ${detail.trim().slice(-240)})`);
	}
	return { ok: failures.length === 0, sourceBroken, failures };
}
