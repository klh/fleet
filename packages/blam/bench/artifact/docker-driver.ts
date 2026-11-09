// bench/artifact/docker-driver.ts — the live docker-desktop bed driver.
// Measures are real: `docker create/start/stop` around a minimal probe.
// Not exercised in CI (bun-only, no Docker); additivity follows the paired
// live.ts pattern. Failure of docker itself throws — recorded, never faked.
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { seededOrder, type ArmRef, type Caps } from "./types.ts";
import type { BedDriver } from "./drivers.ts";

const run = promisify(execFile);

export async function dockerCaps(bed = "docker-desktop"): Promise<Caps> {
	const info = await run("docker", ["info", "--format", "{{.OperatingSystem}}|{{.KernelVersion}}|{{.NCPU}}|{{.MemTotal}}"]);
	const [os, kernel, ncpu, mem] = info.stdout.trim().split("|");
	return {
		bed,
		host: os ?? "unreported",
		kernel: kernel ?? "unreported",
		arch: process.arch,
		cpu: Number(ncpu ?? 0),
		memMiB: Math.round(Number(mem ?? 0) / 1048576),
	};
}

/** cold-start measure: create→start→wait for first output→remove. */
export function dockerDriver(caps: Caps): BedDriver {
	return {
		bed: caps.bed,
		caps,
		async measure(arm: ArmRef, rep: number, seed: number): Promise<number> {
			const order = seededOrder(1, seed + rep * 104729)[0] ?? 0; // per-call jitter seed
			const name = `blam-artifact-${arm.kind}-${rep}-${order}`;
			const t0 = performance.now();
			await run("docker", ["create", "--name", name, arm.id, "/bin/sh", "-c", "echo ready"]);
			try {
				await run("docker", ["start", "-a", name], { timeout: 30_000 });
			} finally {
				await run("docker", ["rm", "-f", name]).catch(() => {});
			}
			return Math.round(performance.now() - t0);
		},
	};
}
