// hooks/lib/lane-guard.ts — W1141 lane credential scoping + egress allowlist
// (the cloud-session bar: https://claude.dev/blog/claude-code-in-the-cloud/ —
// a proxy holds the real credential, the lane gets a short-lived scoped one,
// and everything it does outside the allowed set is logged+denied). Three
// surfaces, one machine conf:
//
//   push    — per-item scoped push credentials: the lane worktree's pushurl
//             rides the local push proxy (:7818), whose credential authorizes
//             ONLY the claim's own branch (refs/heads/suspenders/<item>);
//             main, other lanes' branches, tags and deletions are refused
//             before any byte moves (403, credential-layer).
//   egress  — a local CONNECT/forward proxy (:7817) that permits only the
//             machine-conf allowlist and logs+denies everything else; the
//             lane's settings env pins HTTPS_PROXY/HTTP_PROXY/ALL_PROXY at it.
//   trailers — every lane commit carries `Fleet-Session:`/`Fleet-Item:`
//             (Claude-Session-style transcript tracing; the PreToolUse Bash
//             hook bin/lane-commit-trailer.ts injects the flags, the done
//             gate here verifies they landed).
//
// Machine conf `~/.claude/lane-guard.json` (SUSPENDERS_LANE_GUARD overrides
// the path; `SUSPENDERS_LANE_GUARD=0` disables the whole guard; an absent or
// unparseable conf is INERT — the documented cred-scope posture, a broken
// conf must not DoS every lane). Config-over-code: repos carry placeholders
// only. SUSPENDERS_TRAILER_GATE overrides the trailer-gate mode per process.
import {
	chmodSync,
	existsSync,
	mkdirSync,
	readFileSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";

export const LANE_GUARD_EGRESS_PORT = 7817;
export const LANE_GUARD_PUSH_PORT = 7818;

/** Fleet trailer names (Claude-Session-style transcript tracing). */
export const FLEET_SESSION_TRAILER = "Fleet-Session";
export const FLEET_ITEM_TRAILER = "Fleet-Item";

export interface LaneGuardConf {
	/** push scoping: enforce wires scoped pushurls at take; audit logs only. */
	push?: { mode?: "enforce" | "audit" };
	/** egress allowlist (hostnames; `*.suffix` wildcards) + decision log path. */
	egress?: { allow?: string[]; log?: string };
	/** trailer-gate default mode; SUSPENDERS_TRAILER_GATE env outranks it. */
	trailers?: "enforce" | "audit" | "off";
}

/** The conf path: SUSPENDERS_LANE_GUARD (path or "0"), else the machine home. */
export const laneGuardConfFile = (): string =>
	process.env.SUSPENDERS_LANE_GUARD === "0"
		? ""
		: (process.env.SUSPENDERS_LANE_GUARD ??
			`${process.env.HOME ?? ""}/.claude/lane-guard.json`);

export const laneGuardDisabled = (): boolean =>
	process.env.SUSPENDERS_LANE_GUARD === "0" || !laneGuardConfFile();

/** The parsed conf, or null when the guard is off/inert (absent, unparseable,
 *  or disabled). Never throws — parse failure is inert, not fatal. */
export function loadLaneGuardConf(): LaneGuardConf | null {
	if (process.env.SUSPENDERS_LANE_GUARD === "0") return null;
	const f = laneGuardConfFile();
	if (!f || !existsSync(f)) return null;
	try {
		const raw = JSON.parse(readFileSync(f, "utf8")) as LaneGuardConf;
		return raw && typeof raw === "object" ? raw : null;
	} catch {
		return null;
	}
}

// ---- egress allowlist ------------------------------------------------------

/** True when `host` matches one allowlist entry: exact, or `*.suffix` wildcard
 *  (one-or-more leading labels — `*.local` covers `belt.local` and
 *  `a.b.local`). Case-insensitive; a trailing dot on either side is ignored. */
export function egressHostAllowed(host: string, allow: string[]): boolean {
	const h = host.trim().toLowerCase().replace(/\.$/, "");
	if (!h) return false;
	for (const raw of allow) {
		const e = raw.trim().toLowerCase().replace(/^\./, "").replace(/\.$/, "");
		if (!e) continue;
		if (e === "*") return true;
		if (e.startsWith("*.")) {
			const suffix = e.slice(1); // ".suffix"
			if (h.endsWith(suffix) && h.length > suffix.length) return true;
		} else if (h === e) return true;
	}
	return false;
}

/** Hostname out of a CONNECT authority (`host:port`) or URL. */
export const egressAuthorityHost = (authority: string): string =>
	authority
		.replace(/^\[?([^\]]+)\]?$/, "$1")
		.split(":")[0]
		.trim();

/** The decision log path: conf `egress.log`, else the insights default. */
export const laneEgressLogFile = (conf: LaneGuardConf | null): string =>
	conf?.egress?.log ??
	`${process.env.HOME ?? ""}/.claude-insights/lane-egress.log`;

/** One NDJSON decision row (no payload material — host, verdict, transport). */
export const egressLogLine = (d: {
	host: string;
	port: string;
	verdict: "allow" | "deny";
	via: "connect" | "forward";
}): string => `${JSON.stringify({ ts: new Date().toISOString(), ...d })}\n`;

// ---- push scoping ----------------------------------------------------------

/** The claim branch for a work item (worktree-provision's branch, verbatim). */
export const laneClaimBranch = (item: string): string => `suspenders/${item}`;

export interface PushCommand {
	oldOid: string;
	newOid: string;
	refname: string;
}

const ZEROS = "0".repeat(40);
const HEX40 = /^[0-9a-f]{40}$/;

/** Ref-update commands from a git-receive-pack request body (protocol v0):
 *  pkt-lines `old SP new SP refname NUL capabilities`, a flush-pkt, then the
 *  packfile. Shallow lines may precede the commands. Only the command list is
 *  parsed — the pack bytes are never touched. Returns null on a body that
 *  does not parse (the proxy refuses rather than guesses). */
export function parseReceivePackCommands(
	body: Uint8Array,
): PushCommand[] | null {
	let off = 0;
	const lines: string[] = [];
	while (off + 4 <= body.length) {
		const lenHex = String.fromCharCode(...body.subarray(off, off + 4));
		if (!/^[0-9a-f]{4}$/.test(lenHex)) return null;
		const len = Number.parseInt(lenHex, 16);
		if (len === 0) break; // flush-pkt — command list ends (pack follows)
		if (len < 4 || off + len > body.length) return null;
		let pkt = String.fromCharCode(...body.subarray(off + 4, off + len));
		// pkt includes the trailing LF git appends — strip it
		if (pkt.endsWith("\n")) pkt = pkt.slice(0, -1);
		lines.push(pkt);
		off += len;
	}
	if (lines.length === 0) return null;
	const cmds: PushCommand[] = [];
	for (const line of lines) {
		const noCaps = line.split("\u0000")[0];
		if (noCaps.startsWith("shallow ")) continue;
		const m = /^([0-9a-f]{40}) ([0-9a-f]{40}) (.+)$/.exec(noCaps);
		if (!m) return null;
		cmds.push({ oldOid: m[1], newOid: m[2], refname: m[3] });
	}
	return cmds.length > 0 ? cmds : null;
}

/** Zero-oid — the ref is being DELETED (or created, on the old side). */
export const isDeletion = (c: PushCommand): boolean => c.newOid === ZEROS;
export const isCreation = (c: PushCommand): boolean => c.oldOid === ZEROS;

export interface PushVerdict {
	ok: boolean;
	denied?: PushCommand;
	why?: string;
}

/** The credential-layer verdict: a lane credential authorizes exactly ONE
 *  ref — its own claim branch — and never a deletion. main, a sibling lane's
 *  branch, tags and refs/ heads of other shapes are all refused here, before
 *  any byte is forwarded toward the remote. */
export function pushRefVerdict(
	cmds: PushCommand[],
	branch: string,
): PushVerdict {
	const want = `refs/heads/${branch}`;
	for (const c of cmds) {
		if (c.refname !== want)
			return {
				ok: false,
				denied: c,
				why: `lane-guard: credential authorizes ${want} only — ${c.refname} refused at the credential layer`,
			};
		if (isDeletion(c))
			return {
				ok: false,
				denied: c,
				why: `lane-guard: credential authorizes create/update of ${want} only — deletion refused`,
			};
		if (!HEX40.test(c.oldOid) || !HEX40.test(c.newOid))
			return { ok: false, denied: c, why: "lane-guard: malformed oid" };
	}
	return { ok: true };
}

// ---- push credentials ------------------------------------------------------

/** Token store for one repo: <repo>/.fleet/lane-guard/<sid>.json, 0600.
 *  Keyed by lane sid; the proxy looks the credential up by Basic user. */
export const lanePushTokenDir = (repoRoot: string): string =>
	join(repoRoot, ".fleet", "lane-guard");

export interface LanePushIdentity {
	sid: string;
	item: string;
	branch: string;
	token: string;
	mintedAt: number;
}

/** Mint (or rotate) one lane's push identity and persist it 0600. */
export function mintLanePushIdentity(
	repoRoot: string,
	sid: string,
	item: string,
): LanePushIdentity {
	const dir = lanePushTokenDir(repoRoot);
	mkdirSync(dir, { recursive: true });
	const ident: LanePushIdentity = {
		sid,
		item,
		branch: laneClaimBranch(item),
		token:
			crypto.randomUUID().replace(/-/g, "") +
			crypto.randomUUID().replace(/-/g, ""),
		mintedAt: Date.now(),
	};
	const file = join(dir, `${sid}.json`);
	writeFileSync(file, `${JSON.stringify(ident, null, 2)}\n`);
	chmodSync(file, 0o600);
	return ident;
}

/** Load a lane's push identity; null when the file is absent or unparseable. */
export function loadLanePushIdentity(
	repoRoot: string,
	sid: string,
): LanePushIdentity | null {
	const file = join(lanePushTokenDir(repoRoot), `${sid}.json`);
	if (!existsSync(file)) return null;
	try {
		const raw = JSON.parse(readFileSync(file, "utf8")) as LanePushIdentity;
		return raw && typeof raw.token === "string" && raw.branch ? raw : null;
	} catch {
		return null;
	}
}

/** Constant-time-ish credential check: Basic `sid:token` → the lane's scoped
 *  branch, or null on any mismatch (unknown sid, wrong token). */
export function verifyPushCredential(
	authHeader: string | null,
	repoRoot: string,
): LanePushIdentity | null {
	if (!authHeader) return null;
	const m = /^Basic (.+)$/i.exec(authHeader.trim());
	if (!m) return null;
	let decoded: string;
	try {
		decoded = atob(m[1].trim());
	} catch {
		return null;
	}
	const idx = decoded.indexOf(":");
	if (idx <= 0) return null;
	const sid = decoded.slice(0, idx);
	const token = decoded.slice(idx + 1);
	const ident = loadLanePushIdentity(repoRoot, sid);
	if (!ident) return null;
	if (ident.token.length !== token.length) return null;
	let diff = 0;
	for (let i = 0; i < token.length; i++)
		diff |= ident.token.charCodeAt(i) ^ token.charCodeAt(i);
	return diff === 0 ? ident : null;
}

/** The scoped pushurl for a lane worktree: the proxy front, credentials in
 *  the userinfo (fetch keeps the plain origin — only PUSH is scoped). */
export const scopedPushUrl = (
	ident: LanePushIdentity,
	pushPort = LANE_GUARD_PUSH_PORT,
): string =>
	`http://${encodeURIComponent(ident.sid)}:${ident.token}@127.0.0.1:${pushPort}/fleet.git`;

/** Take-time wiring: when the guard's push mode is enforce, mint/rotate the
 *  item lane's push identity and pin the worktree's remote pushurl at the
 *  proxy. The pin rides WORKTREE-LOCAL config (extensions.worktreeConfig) —
 *  a worktree shares .git/config with every sibling and the main checkout,
 *  so a shared-config pushurl would route the whole repo through one lane's
 *  credential. Fetch is untouched. Returns the identity, or null when the
 *  guard is off/audit (nothing wired — the documented inert posture). */
export function wireLanePushScope(
	root: string,
	wt: string,
	item: string,
	sid: string,
): LanePushIdentity | null {
	const conf = loadLaneGuardConf();
	if (conf?.push?.mode !== "enforce") return null;
	const ident = mintLanePushIdentity(root, sid, item);
	const git = (args: string[]): boolean =>
		Bun.spawnSync(["git", "-C", wt, ...args], {
			stdout: "pipe",
			stderr: "pipe",
		}).exitCode === 0;
	git(["config", "extensions.worktreeConfig", "true"]);
	git(["config", "--worktree", "remote.origin.pushurl", scopedPushUrl(ident)]);
	return ident;
}

// ---- trailers --------------------------------------------------------------

/** git-commit argv tail that injects the trailers (PreToolUse rewrite). */
export const fleetTrailerArgs = (sid: string, item: string): string[] => [
	"--trailer",
	`${FLEET_SESSION_TRAILER}=${sid}`,
	"--trailer",
	`${FLEET_ITEM_TRAILER}=${item}`,
];

export type TrailerGateMode = "enforce" | "audit" | "off";

/** Trailer-gate mode: env outranks machine conf, audit is the default. */
export function trailerGateMode(conf: LaneGuardConf | null): TrailerGateMode {
	const env = process.env.SUSPENDERS_TRAILER_GATE;
	if (env === "enforce" || env === "audit" || env === "off") return env;
	if (env === "0") return "off";
	const c = conf?.trailers;
	if (c === "enforce" || c === "audit" || c === "off") return c;
	return "audit";
}

export interface TrailerVerdict {
	ok: boolean;
	why?: string;
	note?: string;
}

/** The done-gate verification: every NON-MERGE commit in the closure window
 *  carries a Fleet-Session trailer matching this lane's sid. enforce refuses
 *  closure; audit reports and lets it pass; off is silent. */
export function trailerVerdict(o: {
	repo: string;
	baseline: string;
	sha: string;
	sid: string;
	conf?: LaneGuardConf | null;
	run?: (args: string[], cwd: string) => string | null;
}): TrailerVerdict {
	const mode = trailerGateMode(o.conf ?? loadLaneGuardConf());
	if (mode === "off") return { ok: true };
	const run =
		o.run ??
		((args, cwd) => {
			const p = Bun.spawnSync(["git", ...args], {
				cwd,
				stdout: "pipe",
				stderr: "pipe",
			});
			return p.exitCode === 0 ? p.stdout.toString() : null;
		});
	const out = run(
		[
			"log",
			"--format=%H%x09%P%x09%(trailers:key=Fleet-Session,valueonly)",
			`${o.baseline}..${o.sha}`,
		],
		o.repo,
	);
	if (out === null)
		return {
			ok: mode !== "enforce",
			note: "lane-guard: trailer probe unavailable (git failed) — audit continues",
		};
	const missing: string[] = [];
	for (const line of out.split("\n")) {
		if (!line.trim()) continue;
		const [sha, parents, trailer] = line.split("\t");
		if (parents.split(" ").filter(Boolean).length >= 2) continue; // merge
		if (trailer.trim() === o.sid) continue;
		missing.push(
			`${sha.slice(0, 8)}${trailer.trim() ? ` (carries ${trailer.trim()})` : " (none)"}`,
		);
	}
	if (missing.length === 0) return { ok: true };
	const recipe = `lane-guard: ${missing.length} commit(s) in ${o.baseline.slice(0, 8)}..${o.sha.slice(0, 8)} lack a Fleet-Session: ${o.sid} trailer — the lane-commit-trailer hook (per-lane settings) injects it; git commit --trailer "Fleet-Session: ${o.sid}" adds it by hand; SUSPENDERS_TRAILER_GATE=off disables this gate`;
	if (mode === "enforce") return { ok: false, why: recipe };
	return { ok: true, note: `${recipe} [audit]` };
}
