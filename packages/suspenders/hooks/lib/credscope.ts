// hooks/lib/credscope.ts — W250 blast-radius: scoped credential access per
// fleet lane. The owner declares secret paths + which lanes may touch them
// (~/.claude/cred-scope.json; SUSPENDERS_CRED_SCOPE points elsewhere, "0"
// disables). Lanes are fail-CLOSED on DECLARED secrets: touch one not named
// by your sid or work item → denied with the config recipe. Owner sessions
// (no lane identity) are never blocked; nothing declared → inert everywhere.
//
// This scopes DECLARED secrets — a short, explicit list (the sanctioned
// homes from the global credentials law: ~/.gmail.env, signing keys, review
// secrets). It is NOT a secrets detector; content-level secrets remain
// gitleaks' job. Config parse failure fails INERT (a broken scope file must
// not DoS every lane command) — documented posture, not an accident.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

export interface SecretScope {
	path: string;
	lanes: string[];
}

export interface LaneIdentity {
	sid: string;
	item: string;
}

export const credScopeFile = (): string =>
	process.env.SUSPENDERS_CRED_SCOPE ??
	`${process.env.HOME ?? ""}/.claude/cred-scope.json`;

export function loadCredScope(): SecretScope[] {
	if (process.env.SUSPENDERS_CRED_SCOPE === "0") return [];
	const f = credScopeFile();
	try {
		const cfg = JSON.parse(readFileSync(f, "utf8")) as {
			secrets?: SecretScope[];
		};
		return Array.isArray(cfg.secrets) ? cfg.secrets : [];
	} catch {
		return []; // absent/unreadable → nothing declared → inert
	}
}

// expand ~ and $HOME; resolve relative paths against base
export function expandTouch(p: string, base: string): string {
	let t = p;
	if (t === "~" || t.startsWith("~/"))
		t = `${process.env.HOME ?? ""}${t.slice(1)}`;
	else if (t.startsWith("$HOME")) t = `${process.env.HOME ?? ""}${t.slice(5)}`;
	else if (!t.startsWith("/")) t = resolve(base, t);
	return t;
}

// the declared secret this path touches — null = none. Entries ending "/"
// match the dir prefix; file entries match exactly.
export function secretScopeHit(
	p: string,
	secrets: SecretScope[],
): SecretScope | null {
	for (const s of secrets) {
		const e = expandTouch(s.path, "/");
		if (e.endsWith("/")) {
			const d = e.slice(0, -1);
			if (p === d || p.startsWith(`${d}/`)) return s;
		} else if (p === e) {
			return s;
		}
	}
	return null;
}

// a lane may touch when its sid OR its work item is listed
export function laneAllowed(s: SecretScope, lane: LaneIdentity): boolean {
	return s.lanes.includes(lane.sid) || s.lanes.includes(lane.item);
}

// the deny reason, null = allow. `base` resolves relative touch paths.
export function credScopeDeny(
	touchPath: string,
	base: string,
	lane: LaneIdentity | null,
	secrets: SecretScope[],
): string | null {
	if (!lane) return null; // owner sessions are never blocked
	const P = expandTouch(touchPath, base);
	const hit = secretScopeHit(P, secrets);
	if (!hit) return null;
	if (laneAllowed(hit, lane)) return null;
	return `cred-scope: lane ${lane.sid} touched ${P} — outside this lane's credential scope. The owner adds it in ${credScopeFile()}: {"secrets":[{"path":"${hit.path}","lanes":["${lane.sid}"]}]} — then the lane retries.`;
}
