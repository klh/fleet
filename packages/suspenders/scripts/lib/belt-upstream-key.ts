// scripts/lib/belt-upstream-key.ts — W1124.2: the authenticated
// Buckle→Belt peer secret, installer face. Mints ONE machine-level
// 0600 BELT_UPSTREAM_KEY in belt.env (the env file BOTH the belt-swarm
// router and the buckle spoke source via `set -ae`), names that var in
// the Buckle Belt-row (machine BUCKLE_UPSTREAMS override) via
// api_key_env, and exports BUCKLE_UPSTREAMS so the spoke actually loads
// the override. Idempotent (an existing nonempty key is kept), fail
// forward (a step failure fails the install — no open-mode fallback),
// and never logs the value (fingerprint = sha256 prefix only).

import { createHash, randomBytes } from "node:crypto";
import { chmodSync, readFileSync, statSync, writeFileSync } from "node:fs";

export const BELT_UPSTREAM_KEY_VAR = "BELT_UPSTREAM_KEY";
export const BELT_GROUP_NAME = "belt";
export const BELT_ROW_URL = "http://127.0.0.1:4000";
export const BUCKLE_OVERRIDE_VAR = "BUCKLE_UPSTREAMS";

export type EnsureStatus = "kept" | "wired" | "minted";

export interface EnsureResult {
	status: EnsureStatus | "failed";
	note: string;
	/** sha256(value) prefix — correlation without disclosure. */
	fingerprint?: string;
}

const fingerprint = (value: string): string =>
	createHash("sha256").update(value).digest("hex").slice(0, 12);

const is0600 = (path: string): boolean => {
	try {
		return (statSync(path).mode & 0o777) === 0o600;
	} catch {
		return false;
	}
};

/** Lines assigning exactly `name=` (export prefix allowed). */
const assignments = (body: string, name: string): string[] =>
	body
		.split(/\r?\n/)
		.filter((l) => new RegExp(`^\\s*(?:export\\s+)?${name}=`).test(l));

/** Read a single-valued env var from belt.env; undefined = absent or
 *  ambiguous (two assignments = fail closed, never guess). */
export const readBeltEnvVar = (
	path: string,
	name: string,
): string | undefined => {
	let body: string;
	try {
		body = readFileSync(path, "utf8");
	} catch {
		return undefined;
	}
	const hits = assignments(body, name);
	if (hits.length !== 1) return undefined;
	return hits[0]?.slice(hits[0].indexOf("=") + 1);
};

type KeyAction =
	| { action: "kept"; value: string }
	| { action: "minted"; value: string; line?: string }
	| { action: "failed"; reason: string };

/** Pure mint decision for a belt.env body — kept / minted / failed.
 *  `line` carries the assignment being replaced (empty-value backfill). */
const beltKeyAction = (body: string, mint: () => string): KeyAction => {
	const hits = assignments(body, BELT_UPSTREAM_KEY_VAR);
	if (hits.length > 1)
		return {
			action: "failed",
			reason: `${BELT_UPSTREAM_KEY_VAR} assigned more than once in belt.env — fix the file, mint refused`,
		};
	const existing = hits[0];
	const value = existing?.slice(existing.indexOf("=") + 1);
	if (existing !== undefined && value !== "") return { action: "kept", value };
	const fresh = mint();
	if (!/^[0-9a-f]{48}$/.test(fresh))
		return {
			action: "failed",
			reason: "minted key failed the 48-hex shape check — refusing to write",
		};
	return { action: "minted", value: fresh, line: existing };
};

/** Mint/keep the peer key in belt.env (0600, idempotent, fail closed).
 *  The value never appears in the result — the fingerprint does. */
export function ensureBeltUpstreamKey(
	beltEnvPath: string,
	opts: { mint?: () => string } = {},
): EnsureResult {
	let body: string;
	try {
		body = readFileSync(beltEnvPath, "utf8");
	} catch {
		return {
			status: "failed",
			note: `${beltEnvPath} is missing or unreadable — peer key mint refused`,
		};
	}
	const mint = opts.mint ?? ((): string => randomBytes(24).toString("hex"));
	const decided = beltKeyAction(body, mint);
	if (decided.action === "failed")
		return { status: "failed", note: decided.reason };
	if (decided.action === "kept")
		return {
			status: "kept",
			note: `${BELT_UPSTREAM_KEY_VAR} kept (${fingerprint(decided.value)})`,
			fingerprint: fingerprint(decided.value),
		};
	const value = decided.value;
	const next =
		decided.line !== undefined
			? body.replace(decided.line, `${BELT_UPSTREAM_KEY_VAR}=${value}`)
			: `${body.replace(/\n*$/, "\n")}${BELT_UPSTREAM_KEY_VAR}=${value}\n`;
	writeFileSync(beltEnvPath, next, { mode: 0o600 });
	if (!is0600(beltEnvPath)) chmodSync(beltEnvPath, 0o600);
	return {
		status: "minted",
		note: `${BELT_UPSTREAM_KEY_VAR} minted (${fingerprint(value)})`,
		fingerprint: fingerprint(value),
	};
}

/** The belt group entry as YAML lines, nested INSIDE the top-level
 *  `groups:` mapping (the shape loadUpstreams/mergeUpstreams read — a
 *  top-level `belt:` key would be dead weight). */
export const beltRowLines = (): string[] => [
	`  ${BELT_GROUP_NAME}:`,
	`    - url: ${BELT_ROW_URL}`,
	`      dialect: anthropic`,
	`      adapter: anthropic`,
	`      api_key_env: ${BELT_UPSTREAM_KEY_VAR}`,
];

/** The canonical authenticated override doc (group name == wire id; the
 *  row NAMES the env var — the secret value never lands in this file). */
export const beltRowBlock = (): string =>
	["groups:", ...beltRowLines()].join("\n");

const safeParse = (text: string): Record<string, unknown> | null => {
	try {
		const doc: unknown = Bun.YAML.parse(text);
		if (doc && typeof doc === "object" && !Array.isArray(doc))
			return doc as Record<string, unknown>;
		return null;
	} catch {
		return null;
	}
};

/** The belt group resolves to exactly the single authenticated row. */
export const rowWired = (doc: unknown): boolean => {
	const groups = (doc as { groups?: unknown })?.groups;
	if (!groups || typeof groups !== "object") return false;
	const rows = (groups as Record<string, unknown>)[BELT_GROUP_NAME];
	if (!Array.isArray(rows) || rows.length !== 1) return false;
	const row = rows[0] as Record<string, unknown> | null;
	return (
		row?.url === BELT_ROW_URL &&
		row?.dialect === "anthropic" &&
		row?.api_key_env === BELT_UPSTREAM_KEY_VAR
	);
};

/** Locate the belt block inside the top-level `groups:` mapping: the
 *  `  <group>:` child line and its [start, endExclusive) span (the next
 *  same-indent sibling or top-level key ends it; EOF otherwise).
 *  groupsLine = -1 when no block-style `groups:` exists; start = -1 when
 *  the group is absent inside an existing mapping (insert after
 *  groupsLine). Comment/blank lines never terminate a span. */
export const beltBlockSpan = (
	lines: string[],
	group: string,
): { groupsLine: number; start: number; end: number } => {
	const groupsLine = lines.findIndex((l) => /^groups:\s*$/.test(l));
	if (groupsLine === -1) return { groupsLine: -1, start: -1, end: -1 };
	let start = -1;
	let end = lines.length;
	for (let i = groupsLine + 1; i < lines.length; i++) {
		const line = lines[i] ?? "";
		if (/^\s*#/.test(line) || line.trim() === "") continue;
		if (/^\S/.test(line)) {
			end = i;
			break;
		}
		if (start === -1) {
			if (line === `  ${group}:`) start = i;
		} else if (/^ {2}\S/.test(line)) {
			end = i;
			break;
		}
	}
	return { groupsLine, start, end };
};

/** Comment-preserving belt-group write: seed or replace ONLY the `belt`
 *  group block; kept = the block already matches byte-for-byte. */
export function writeBeltRowBlock(overridePath: string): EnsureResult {
	let body = "";
	try {
		body = readFileSync(overridePath, "utf8");
	} catch {
		body = ""; // absent file → seed the override with the row
	}
	if (body.trim() !== "" && safeParse(body) === null)
		return {
			status: "failed",
			note: `${overridePath} does not parse as YAML — Belt-row wiring refused`,
		};
	const lines = body === "" ? [] : body.replace(/\n*$/, "").split("\n");
	const want = beltRowLines();
	const span = beltBlockSpan(lines, BELT_GROUP_NAME);
	if (
		span.start !== -1 &&
		lines.slice(span.start, span.end).join("\n") === want.join("\n")
	)
		return { status: "kept", note: `belt row kept in ${overridePath}` };
	if (span.groupsLine === -1) lines.push(...beltRowBlock().split("\n"));
	else if (span.start === -1) lines.splice(span.groupsLine + 1, 0, ...want);
	else lines.splice(span.start, span.end - span.start, ...want);
	writeFileSync(overridePath, `${lines.join("\n")}\n`, { mode: 0o600 });
	return { status: "wired", note: `belt row written to ${overridePath}` };
}

/** Ensure + validate the authenticated Belt-row: fail closed when the
 *  file does not parse or the row does not hold after the write. */
export function wireBeltRow(overridePath: string): EnsureResult {
	const wrote = writeBeltRowBlock(overridePath);
	if (wrote.status === "failed" || wrote.status === "kept") return wrote;
	const after = safeParse(readFileSync(overridePath, "utf8"));
	if (after === null || !rowWired(after))
		return {
			status: "failed",
			note: `${overridePath} failed post-write validation — inspect the file`,
		};
	return {
		status: "wired",
		note: `belt row wired (api_key_env ${BELT_UPSTREAM_KEY_VAR}) in ${overridePath}`,
	};
}

/** Export BUCKLE_UPSTREAMS in belt.env so the plist-sourced spoke loads
 *  the machine override (belt-swarm sources the same file; the var is
 *  meaningless there). Idempotent; the path is config, not a secret. */
export function wireBuckleUpstreamsEnv(
	beltEnvPath: string,
	overridePath: string,
): EnsureResult {
	const current = readBeltEnvVar(beltEnvPath, BUCKLE_OVERRIDE_VAR);
	if (current === overridePath)
		return { status: "kept", note: `${BUCKLE_OVERRIDE_VAR} kept` };
	let body: string;
	try {
		body = readFileSync(beltEnvPath, "utf8");
	} catch {
		return {
			status: "failed",
			note: `${beltEnvPath} is missing or unreadable — ${BUCKLE_OVERRIDE_VAR} wiring refused`,
		};
	}
	const lines = body.replace(/\n*$/, "").split("\n");
	const hits = assignments(body, BUCKLE_OVERRIDE_VAR);
	if (hits.length > 1)
		return {
			status: "failed",
			note: `${BUCKLE_OVERRIDE_VAR} assigned more than once in belt.env — fix the file`,
		};
	if (hits.length === 1)
		lines[lines.indexOf(hits[0] ?? "")] =
			`${BUCKLE_OVERRIDE_VAR}=${overridePath}`;
	else lines.push(`${BUCKLE_OVERRIDE_VAR}=${overridePath}`);
	writeFileSync(beltEnvPath, `${lines.join("\n")}\n`, { mode: 0o600 });
	if (!is0600(beltEnvPath)) chmodSync(beltEnvPath, 0o600);
	return {
		status: "wired",
		note: `${BUCKLE_OVERRIDE_VAR} wired → ${overridePath}`,
	};
}

export interface PeerWiring {
	beltEnvPath: string;
	overridePath: string;
}

/** Runtime parity probe: every face of the peer-auth wiring in place.
 *  Read-only — used by tests and doctor-style checks. */
export function verifyBeltPeerWiring(
	wiring: PeerWiring,
	env: Record<string, string | undefined> = process.env,
): { ok: boolean; reasons: string[] } {
	const reasons: string[] = [];
	const key = readBeltEnvVar(wiring.beltEnvPath, BELT_UPSTREAM_KEY_VAR);
	if (key === undefined || key === "")
		reasons.push(
			`${wiring.beltEnvPath}: ${BELT_UPSTREAM_KEY_VAR} missing/empty`,
		);
	if (!is0600(wiring.beltEnvPath))
		reasons.push(`${wiring.beltEnvPath}: must be 0600`);
	if (env[BUCKLE_OVERRIDE_VAR] !== wiring.overridePath)
		reasons.push(
			`${BUCKLE_OVERRIDE_VAR} env does not name the machine override`,
		);
	const doc = safeParse(readOrEmpty(wiring.overridePath));
	if (doc === null || !rowWired(doc))
		reasons.push(`${wiring.overridePath}: authenticated belt row not wired`);
	return { ok: reasons.length === 0, reasons };
}

const readOrEmpty = (path: string): string => {
	try {
		return readFileSync(path, "utf8");
	} catch {
		return "";
	}
};
