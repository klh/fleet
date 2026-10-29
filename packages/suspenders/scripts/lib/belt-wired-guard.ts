import { lstatSync, readFileSync } from "node:fs";
import { totalmem } from "node:os";

const GIB = 1024 ** 3;
const CGROUP_LIMITS = [
	"/sys/fs/cgroup/memory.max",
	"/sys/fs/cgroup/memory/memory.limit_in_bytes",
];

/** Container memory limits can be lower than os.totalmem(). Invalid or
 * unlimited cgroup values leave the host figure unchanged. */
export function effectiveMemoryBytes(
	hostBytes: number,
	limitBodies: readonly string[],
): number {
	let effective = hostBytes;
	for (const body of limitBodies) {
		const value = body.trim();
		if (!/^\d+$/.test(value)) continue;
		const bytes = Number(value);
		if (Number.isSafeInteger(bytes) && bytes > 0 && bytes < effective)
			effective = bytes;
	}
	return effective;
}

/** Reserve half the available memory for the OS and other processes. A
 * fresh install gets a conservative machine value; an existing belt.env is
 * never inferred or rewritten. */
export function freshWiredGuardGb(
	hostBytes = totalmem(),
	limitBodies: readonly string[] = CGROUP_LIMITS.map((path) => {
		try {
			return readFileSync(path, "utf8");
		} catch {
			return "";
		}
	}),
): string {
	const bytes = effectiveMemoryBytes(hostBytes, limitBodies);
	return String(Math.max(0.01, Math.floor((bytes / GIB) * 50) / 100));
}

export type BeltWiredGuardValidation =
	| { ok: true; value: string }
	| { ok: false; reason: string };

/** One private machine value feeds both the Belt envFile and dispatch. */
export function validateBeltWiredGuard(path: string): BeltWiredGuardValidation {
	let body: string;
	try {
		const stat = lstatSync(path);
		if (!stat.isFile() || (stat.mode & 0o777) !== 0o600)
			return { ok: false, reason: "belt.env must be a regular 0600 file" };
		body = readFileSync(path, "utf8");
	} catch {
		return { ok: false, reason: "belt.env is missing or unreadable" };
	}
	const key = "BELT_WIRED_GUARD_GB=";
	const entries = body
		.split(/\r?\n/)
		.filter((line) => /^\s*(?:export\s+)?BELT_WIRED_GUARD_GB\s*=/.test(line));
	if (entries.length !== 1 || !entries[0]?.startsWith(key))
		return {
			ok: false,
			reason:
				"BELT_WIRED_GUARD_GB must appear exactly once as a plain assignment in belt.env",
		};
	const value = entries[0]?.slice(key.length) ?? "";
	if (
		!/^\d+(?:\.\d+)?$/.test(value) ||
		!Number.isFinite(Number(value)) ||
		Number(value) <= 0
	)
		return {
			ok: false,
			reason: "BELT_WIRED_GUARD_GB must be a positive decimal number",
		};
	return { ok: true, value };
}
