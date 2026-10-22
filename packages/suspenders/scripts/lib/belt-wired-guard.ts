import { lstatSync, readFileSync } from "node:fs";

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
