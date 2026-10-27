// hooks/lib/cred-scope.ts — W1211 credential-scoped work routing. Items
// declare required credentials via --requires (the controlled vocabulary
// below); a machine ADVERTISES the provider scopes it actually holds
// (~/.claude/local-llm/credential-scope.json, 0600, config-over-code) and
// hub machines declare none — so credentialed work is STRUCTURALLY
// unroutable to them: absence at the credential layer (W1141), never gate
// prose. Three enforcement layers read the same vocabulary:
//   1. the allocator (work-alloc.ts) filters READY×lanes on
//      requires ⊆ session capabilities (session-start stamps the machine
//      scope into every top-level session's caps);
//   2. `work take` refuses when item.requires ⊄ session caps ∪ machine
//      scope (bin/work.ts, backstop for stale/inherited lane rows);
//   3. dispatch pre-gates on the machine scope and scrubs provider
//      credential env vars from the lane env unless the item requires AND
//      the machine declares the matching scope.
// A lane that still hits an auth/credential error gets classified by
// classifyCredError (cred-gap-scan.ts) → a requires.gap event + an
// automatic requires-stamp on the item: the next brief carries the real
// requirement, not a blind retry.
import { readFileSync, statSync } from "node:fs";
import type { GovernorStore } from "./govdb/govdb.ts";
import { CAPABILITIES } from "./govdb/govdb.ts";

// ─── vocabulary ──────────────────────────────────────────────────────────────
// Credential scopes extend (never replace) the runtime capability
// vocabulary: fixed provider tokens (gh, az) plus prefixed classes
// cloud-<provider> / tool-<cli>. Lowercase kebab, per the owner constraint
// 2026-10-23 (W1124.18 direction): hubs get NO gh/az credentials or CLIs.
export const CRED_SCOPE_RE =
	/^(gh|az|cloud-[a-z0-9][a-z0-9-]*|tool-[a-z0-9][a-z0-9-]*)$/;

export const isCredScope = (t: string): boolean => CRED_SCOPE_RE.test(t);

/** One token of the full --requires vocabulary: a runtime capability OR a
 *  credential scope. */
export const validScopeToken = (t: string): boolean =>
	(CAPABILITIES as readonly string[]).includes(t) || isCredScope(t);

const csvTokens = (raw: string | null | undefined): string[] =>
	(raw ?? "")
		.split(",")
		.map((t) => t.trim())
		.filter(Boolean);

/** Validate + normalize a --requires csv against the full vocabulary.
 *  Throws with the offending token (callers die()); returns trimmed csv. */
export function assertRequires(raw: string): string {
	const caps = csvTokens(raw);
	const bad = caps.filter((c) => !validScopeToken(c));
	if (bad.length > 0)
		throw new Error(
			`unknown scope: ${bad.join(",")} — vocabulary: ${CAPABILITIES.join(",")}, gh, az, cloud-<provider>, tool-<cli>`,
		);
	return caps.join(",");
}

/** The credential-scope tokens of a requires csv (runtime caps excluded). */
export const credScopesOf = (requires: string | null | undefined): string[] =>
	csvTokens(requires).filter(isCredScope);

/** Credential scopes a requires set names that `declared` does not hold. */
export function credScopeGap(
	requires: string | null | undefined,
	declared: readonly string[],
): string[] {
	const have = new Set(declared);
	return credScopesOf(requires).filter((s) => !have.has(s));
}

/** The take/dispatch routing view of what a session may claim: its row's
 *  capabilities ∪ the machine's declared credential scope (live union —
 *  stale or parent-inherited session rows cannot widen past the machine). */
export function advertisedCaps(
	session: { capabilities: string | null } | null,
	machine: readonly string[],
): string[] {
	return [
		...new Set([
			...(session?.capabilities ?? "").split(",").filter(Boolean),
			...machine,
		]),
	];
}

// ─── machine advertisement ───────────────────────────────────────────────────
export const credScopeFile = (): string =>
	process.env.KLH_CRED_SCOPE_FILE?.trim() ||
	`${process.env.HOME ?? ""}/.claude/local-llm/credential-scope.json`;

// per-request reads (dispatch, fleet-loop ticks) repeat stat+parse on a file
// that changes at most once per operator edit — mtime-keyed cache, one stat
// per read (profile.ts capCache precedent).
const scopeCache = new Map<string, { mtimeMs: number; scopes: string[] }>();

/** The machine's DECLARED credential scopes. Default = EMPTY (a machine that
 *  never declared is hub-postured: it advertises no provider scope, so
 *  credentialed work refuses here). Unreadable/malformed fails SAFE the same
 *  way; invalid tokens are dropped, never granted. */
export function machineCredScope(): string[] {
	const file = credScopeFile();
	let mtimeMs = -1;
	try {
		mtimeMs = statSync(file).mtimeMs;
	} catch {
		// absent → empty below
	}
	const hit = scopeCache.get(file);
	if (hit && hit.mtimeMs === mtimeMs) return hit.scopes;
	const scopes = (() => {
		if (mtimeMs < 0) return [];
		try {
			const raw = JSON.parse(readFileSync(file, "utf8")) as {
				scopes?: unknown;
			};
			if (!Array.isArray(raw.scopes)) return [];
			return raw.scopes
				.filter((s): s is string => typeof s === "string")
				.map((s) => s.trim())
				.filter((s) => isCredScope(s));
		} catch {
			return []; // malformed → fail safe
		}
	})();
	scopeCache.set(file, { mtimeMs, scopes });
	return scopes;
}

// ─── routing refusal (dispatch pre-gate message) ────────────────────────────
export function credRoutingRefusal(
	requires: string | null | undefined,
	declared: readonly string[],
): string | null {
	const gap = credScopeGap(requires, declared);
	if (gap.length === 0) return null;
	return `credential scope gap: requires [${gap.join(",")}] beyond machine scope [${declared.join(",") || "none"}] — declare it in ${credScopeFile()} {"scopes":["..."]} or route to a machine that holds it`;
}

// ─── lane env hygiene ────────────────────────────────────────────────────────
// Provider credential env vars, keyed to the scope that must require AND
// declare them before they ride a lane env. W1141: absence, not prose.
const PROVIDER_ENV: Array<[RegExp, string]> = [
	[/^GH_|^GITHUB_/, "gh"],
	[/^AZ_|^AZURE_/, "az"],
	[/^CLOUDSDK_|^GOOGLE_APPLICATION_CREDENTIALS/, "cloud-gcp"],
	[/^AWS_/, "cloud-aws"],
];

const providerScopeOfKey = (key: string): string | null => {
	for (const [re, scope] of PROVIDER_ENV) if (re.test(key)) return scope;
	return null;
};

/** The lane env: provider credential vars ride ONLY when the item requires
 *  the matching scope AND the machine declares it; everything else is a
 *  copy with those keys deleted. Non-provider keys pass untouched. */
export function laneProviderEnv(
	env: Record<string, string | undefined>,
	requires: string | null | undefined,
	declared: readonly string[],
): Record<string, string | undefined> {
	const req = new Set(credScopesOf(requires));
	const dec = new Set(declared);
	const out = { ...env };
	for (const key of Object.keys(out)) {
		const scope = providerScopeOfKey(key);
		if (scope && !(req.has(scope) && dec.has(scope))) delete out[key];
	}
	return out;
}

// ─── misroute detection (cred-gap-scan) ─────────────────────────────────────
// One lane-log line → the missing scope, or null. Deliberately conservative:
// failure-shaped context required on the noisy classes (a lane mentioning
// `gh auth` in passing must not false-positive).
export function classifyCredError(line: string): string | null {
	const missing = /\bcommand not found:?\s+(\S+)/i.exec(line);
	if (missing) {
		const bin = missing[1].split("/").pop()?.toLowerCase() ?? "";
		if (bin === "gh") return "gh";
		if (bin === "az") return "az";
		if (bin && /^[a-z][a-z0-9-]*$/.test(bin)) return `tool-${bin}`;
		return null;
	}
	if (/authentication failed for 'https:\/\/[^\s']*github\.com/i.test(line))
		return "gh";
	if (
		/github\.com.*(bad credentials|requires authentication|http 40[13])/i.test(
			line,
		)
	)
		return "gh";
	if (/\b(?:please run|run):? gh auth login\b/i.test(line)) return "gh";
	if (
		/\bgh: /i.test(line) &&
		/(?:auth|credential|login|failed|denied)/i.test(line)
	)
		return "gh";
	if (/\brun ['"]?az login\b|AADSTS\d{5,}/i.test(line)) return "az";
	if (
		/\baz: /i.test(line) &&
		/(?:not logged in|login required|credential)/i.test(line)
	)
		return "az";
	if (
		/\bgcloud auth\b|reauth(?:enticat)?(?:ing|ion)? required.*gcloud/i.test(
			line,
		)
	)
		return "cloud-gcp";
	if (
		/unable to locate credentials|security token included in the request is expired/i.test(
			line,
		)
	)
		return "cloud-aws";
	return null;
}

// ─── audit face (work stamp) ────────────────────────────────────────────────
type Db = Pick<GovernorStore, "query">;

/** `work stamp <id> --requires <csv>`: set an EXISTING item's requires set
 *  (the audit makes implicit credential needs explicit; cred-gap-scan
 *  stamps the scope a lane proved missing). Emits requires.stamped. */
export function stampRequires(
	db: Db,
	project: string,
	id: string,
	raw: string | undefined,
	deps: {
		die: (msg: string) => never;
		emit: (kind: string, id: string, extra: Record<string, string>) => void;
	},
): string {
	const { die, emit } = deps;
	if (!raw) die("usage: stamp <id> --requires <csv>");
	let csv: string;
	try {
		csv = assertRequires(raw);
	} catch (error) {
		die(`requires: ${error instanceof Error ? error.message : String(error)}`);
	}
	const row = db
		.query("SELECT id FROM work_items WHERE project = ? AND id = ?")
		.get(project, id) as { id: string } | null;
	if (!row) die(`no such work item in this project: ${id}`);
	db.query(
		"UPDATE work_items SET requires = ?, updated_at = ? WHERE project = ? AND id = ?",
	).run(csv || null, Date.now(), project, id);
	emit("requires.stamped", id, { requires: csv });
	return `stamped ${id} requires [${csv || "(cleared)"}]`;
}
