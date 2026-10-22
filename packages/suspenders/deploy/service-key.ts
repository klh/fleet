// deploy/service-key.ts — W1124.15 service-key lifecycle for hubctl: mint,
// verify, and install-gate the PERSISTENT proxy-only credentials spoke→hub
// links use (distinct from short-lived expiring lane keys). Extracted from
// hubctl.ts (W744 decomposition): hubctl keeps verb dispatch + the hub exec
// runner (injected below); this module imports nothing from hubctl.
import { lstatSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import type { HubProfile } from "../hooks/lib/stack-config.ts";

/** The hub exec face — implemented by hubctl's runOnHub. A callback TYPE
 *  (dependency injection): the dependency points one way, hubctl→here. */
export type ServiceKeyRunner = (
	hub: HubProfile,
	script: string,
	opts?: { input?: string },
) => string;

/** W1124.15: the ONE scope a persistent service credential carries — proxy
 *  use only, never admin, never key custody. Same proxy scope as lane keys,
 *  but the credential is PERSISTENT: the mint body carries no expires_in_s,
 *  so the admin API stores expires_at = null. */
export const SERVICE_KEY_SCOPES = ["buckle:proxy:WRITE_"];

/** W1124.15: mint a PERSISTENT proxy-only service credential ON the hub —
 *  the body carries NO expires_in_s (admin API stores expires_at = null), so
 *  spoke/persistent hub links never die of an expiry the lane TTL ladder
 *  owns. Audited: the admin issue route appends the hash-chained `issued`
 *  auth event; old identities stay in the ledger (this mints, never rotates
 *  or revokes). Same hub-side script + same interface as mint-lane-key. */
export function mintServiceKey(
	runner: ServiceKeyRunner,
	hub: HubProfile,
	hubName: string,
	name: string,
	outPath: string,
): void {
	// persistent service credential: body carries NO expires_in_s; the raw
	// material lands in outPath (0600) — stdout carries metadata ONLY
	runMintOnHub(
		runner,
		hub,
		hubName,
		JSON.stringify({ name, scopes: SERVICE_KEY_SCOPES }),
		outPath,
	);
}

/** Shared mint exec — ONE hub-side script + response parse for every hub
 *  (W1124.15: mint-service-key joins mint-lane-key on this interface). The
 *  root credential is read on the device, never printed or transported. */
export function runMintOnHub(
	runner: ServiceKeyRunner,
	hub: HubProfile,
	hubName: string,
	body: string,
	storeTo?: string,
): void {
	const port = hub.buckle_port;
	const root = hub.secrets?.buckle_root_key;
	if (!port || !root)
		throw new Error(
			`hub ${hubName} needs buckle_port + secrets.buckle_root_key in stack.yaml`,
		);
	execMintOnHub(runner, hub, String(port), root, body, storeTo);
}

const MINT_LANE_KEY_SCRIPT = [
	"umask 077",
	"K=$(sed -n 's/^BUCKLE_ROOT_KEY=//p' \"$1\" | head -n1 | tr -d '\\r\\n')",
	'[ -n "$K" ] || { echo "hub root key missing at $1" >&2; exit 3; }',
	"curl --max-time 15 -sS -X POST \\",
	'  -H "Authorization: Bearer $K" -H "content-type: application/json" \\',
	'  -d "$2" -w \'\\n%{http_code}\' "http://127.0.0.1:$3/v1/admin/keys"',
].join("\n");

/** The shared mint tail: script exec + response parse. The hub-side script's
 *  diagnostic (e.g. root key missing) rides stderr. Raw key material rides
 *  stdout ONCE — the issue response — never the root credential. */
function execMintOnHub(
	runner: ServiceKeyRunner,
	hub: HubProfile,
	port: string,
	root: string,
	body: string,
	storeTo?: string,
): void {
	const quote = (a: string): string => `'${a.replace(/'/g, `'\\''`)}'`;
	let out: string;
	try {
		out = runner(
			hub,
			// script args: $1=root-key file, $2=curl body, $3=gate port —
			// the script reads -d "$2" and port "$3" (W974: was swapped, every
			// mint 400'd on a JSON-body URL)
			`/bin/sh -c ${quote(MINT_LANE_KEY_SCRIPT)} sh ${quote(root)} ${quote(body)} ${quote(port)}`,
		);
	} catch (e) {
		const err = e as { stderr?: unknown; message?: unknown };
		const hint =
			typeof err.stderr === "string" && err.stderr.trim().length > 0
				? err.stderr.trim()
				: typeof err.message === "string"
					? err.message
					: String(e);
		console.log(`hubctl mint: ${hint}`);
		process.exit(1);
	}
	parseMintOutput(out, storeTo);
}

/** Parse the mint script output (payload + trailing status line) — exit 1 on
 *  a rejected mint (non-2xx). Lane keys print the payload (short-lived raw
 *  material rides stdout once); SERVICE keys store it via storeTo and print
 *  metadata ONLY — a durable credential is never on stdout (W1124.15). */
function parseMintOutput(out: string, storeTo?: string): void {
	const lines = out.trimEnd().split("\n");
	const status = Number(lines.at(-1));
	const payload = lines.slice(0, -1).join("\n");
	if (!(status >= 200 && status < 300)) {
		console.log(payload || `hub gate answered ${status} — key not minted`);
		process.exit(1);
	}
	if (storeTo !== undefined) {
		storeServiceKeyMint(payload, storeTo);
		return;
	}
	console.log(payload);
}

/** W1124.15: land the raw service credential ATOMICALLY at 0600 — temp file
 *  + rename in the same dir, refuse an existing target; stdout metadata. */
function storeServiceKeyMint(payload: string, outPath: string): void {
	const minted = parseMintPayload(payload);
	if (minted === null) {
		console.log("hubctl mint-service-key: unparseable/incomplete mint answer");
		process.exit(1);
	}
	storeKeyMintFile(minted, outPath);
}

/** The mint answer's fields — null unless raw key material is present. */
function parseMintPayload(payload: string): ServiceMint | null {
	let v: {
		key?: unknown;
		key_id?: unknown;
		scopes?: unknown;
		expires_at?: unknown;
	};
	try {
		v = JSON.parse(payload);
	} catch {
		return null;
	}
	if (typeof v.key !== "string" || v.key.length === 0) return null;
	return {
		key: v.key,
		key_id: typeof v.key_id === "string" ? v.key_id : null,
		scopes: Array.isArray(v.scopes)
			? v.scopes.filter((s): s is string => typeof s === "string")
			: [],
		expires_at: typeof v.expires_at === "number" ? v.expires_at : null,
	};
}

interface ServiceMint {
	key: string;
	key_id: string | null;
	scopes: string[];
	expires_at: number | null;
}

/** W1124.15: the deploy-gate face — nothing declared = nothing to check;
 *  declared-and-failed fails the install with the evidence printed above. */
export function verifyConfiguredServiceKey(
	runner: ServiceKeyRunner,
	hub: HubProfile,
	name: string,
): boolean {
	const path = hub.secrets?.buckle_service_key;
	if (!path) return true;
	if (
		verifyKeyFile(runner, hub, name, path, hub.secrets?.buckle_service_key_env)
	)
		return true;
	console.log(
		`deploy: ${name} — configured cross-hub key failed verification (evidence above)`,
	);
	return false;
}

/** W1124.15: validate a configured cross-hub key against the hub's own verify
 *  API. The root credential stays on the hub device (the script reads it
 *  there); the candidate key value rides ssh STDIN once — never an argv
 *  element, never hub disk, never output. Returns the boolean verdict. */
export function verifyKeyFile(
	runner: ServiceKeyRunner,
	hub: HubProfile,
	hubName: string,
	path: string,
	envName?: string,
): boolean {
	const port = hub.buckle_port;
	const root = hub.secrets?.buckle_root_key;
	if (!port || !root) {
		console.log(
			`hubctl verify-key: hub ${hubName} needs buckle_port + secrets.buckle_root_key in stack.yaml`,
		);
		return false;
	}
	const sel = selectKeyCandidate(path, envName);
	if ("error" in sel) {
		console.log(`✗ ${sel.error}`);
		return false;
	}
	return postVerify(runner, hub, hubName, path, sel.key);
}

/** The verify exec tail: POST the verify API via the hub-side script (the
 *  JSON body — candidate key inside — rides STDIN), then parse the verdict. */
function postVerify(
	runner: ServiceKeyRunner,
	hub: HubProfile,
	hubName: string,
	path: string,
	candidate: string,
): boolean {
	const quote = (a: string): string => `'${a.replace(/'/g, `'\\''`)}'`;
	const body = JSON.stringify({ key: candidate });
	let out: string;
	try {
		out = runner(
			hub,
			`/bin/sh -c ${quote(VERIFY_KEY_SCRIPT)} sh ${quote(hub.secrets?.buckle_root_key ?? "")} ${quote(String(hub.buckle_port))}`,
			{ input: body },
		);
	} catch (e) {
		console.log(
			`✗ verify: hub unreachable or exec failed (${e instanceof Error ? e.message : String(e)})`,
		);
		return false;
	}
	return parseVerifyOutput(hubName, path, out);
}

// W1124.15: script run ON the hub — reads the root credential where it lives
// ($1), takes the verify REQUEST BODY from stdin (the candidate key value is
// inside it — never an argv element, never hub disk), and POSTs the hub's own
// admin verify API from inside the device. Answers `payload\n<http_code>`.
const VERIFY_KEY_SCRIPT = [
	"umask 077",
	"K=$(sed -n 's/^BUCKLE_ROOT_KEY=//p' \"$1\" | head -n1 | tr -d '\\r\\n')",
	'[ -n "$K" ] || { echo "hub root key missing at $1" >&2; exit 3; }',
	"B=$(cat)",
	'[ -n "$B" ] || { echo "verify: no request body on stdin" >&2; exit 3; }',
	"curl --max-time 15 -sS -X POST \\",
	'  -H "Authorization: Bearer $K" -H "content-type: application/json" \\',
	'  -d "$B" -w \'\\n%{http_code}\' "http://127.0.0.1:$2/v1/admin/keys/verify"',
].join("\n");

/** Map the verify API answer to the boolean verdict — the hub's ACTUAL code
 *  (buckle.key_expired / buckle.key_revoked / buckle.invalid_key) rides the
 *  failure line with a mint-and-install remediation. Key material is never
 *  part of any answer, so payload text is safe to print. */
function parseVerifyOutput(
	hubName: string,
	path: string,
	out: string,
): boolean {
	const lines = out.trimEnd().split("\n");
	const status = Number(lines.at(-1));
	const payload = lines.slice(0, -1).join("\n");
	if (!(status >= 200 && status < 300)) {
		console.log(
			`✗ verify: hub gate answered ${status} — ${payload || "no body"}`,
		);
		return false;
	}
	return verifyPayloadVerdict(hubName, path, payload);
}

/** The 2xx branch: JSON-parse the answer, map valid:false to the actionable
 *  failure (exact code + mint/install remediation), valid:true to the check
 *  line. Old identities stay in the ledger — this never revokes anything. */
function verifyPayloadVerdict(
	hubName: string,
	path: string,
	payload: string,
): boolean {
	let v: { valid?: boolean; code?: string; key_id?: string; scopes?: string[] };
	try {
		v = JSON.parse(payload);
	} catch {
		console.log(`✗ verify: unparseable answer — ${payload.slice(0, 200)}`);
		return false;
	}
	if (v.valid !== true) {
		const code = typeof v.code === "string" ? v.code : "unknown";
		const why =
			code === "buckle.key_expired"
				? "EXPIRED on this hub"
				: code === "buckle.key_revoked"
					? "REVOKED on this hub"
					: "not valid on this hub";
		console.log(`✗ ${path}: ${code} — the configured cross-hub key is ${why}`);
		console.log(
			`  remediation: hubctl mint-service-key ${hubName} --name <name> → install the new key into ${path} (0600); the old key_id stays in the hub audit ledger`,
		);
		return false;
	}
	console.log(
		`✓ ${path}: valid (key_id=${v.key_id ?? "?"}, scopes=${(v.scopes ?? []).join(",") || "none"})`,
	);
	return true;
}

/** One candidate line in a configured key file. */
interface KeyCandidate {
	name: string | null;
	value: string;
}

/** W1124.15: read the raw key from a configured credential file — NAME=value
 *  form or a bare key line. The file MUST be 0600 (it holds a bearer
 *  credential); a multi-variable file (spoke env files START with the root
 *  key) demands the explicit env NAME — lines are never guessed. */
function selectKeyCandidate(
	path: string,
	envName: string | undefined,
): { key: string } | { error: string } {
	const st = lstatSync(path, { throwIfNoEntry: false });
	if (!st) return { error: `${path}: cannot read the configured key file` };
	// lstat BEFORE any read: a symlinked (or special-file) credential is a
	// target-swap hazard — regular file only, then the 0600 gate.
	if (!st.isFile() || st.isSymbolicLink())
		return {
			error: `${path}: not a regular file — a credential file is never a symlink or device`,
		};
	if ((st.mode & 0o777) !== 0o600)
		return {
			error: `${path}: mode ${(st.mode & 0o777).toString(8)} — a credential file must be 0600 (chmod 600 ${path})`,
		};
	let text: string;
	try {
		text = readFileSync(path, "utf8");
	} catch {
		return { error: `${path}: cannot read the configured key file` };
	}
	return selectFromLines(path, envName, text.split("\n"));
}

/** The line selection + ambiguity rule (env NAME when the file is
 *  multi-variable — the first line of a spoke env file is the ROOT key,
 *  never guessed). Split out so IO and policy test separately. */
function selectFromLines(
	path: string,
	envName: string | undefined,
	lines: string[],
): { key: string } | { error: string } {
	const candidates: KeyCandidate[] = [];
	for (const line of lines) {
		if (line.trim().length === 0) continue;
		const kv = /^[A-Za-z_][A-Za-z0-9_]*=(.+)$/.exec(line);
		if (kv !== null && kv[1] !== undefined) {
			candidates.push({
				name: line.slice(0, line.indexOf("=")),
				value: kv[1].trim(),
			});
			continue;
		}
		candidates.push({ name: null, value: line.trim() });
	}
	if (envName !== undefined) {
		const hit = candidates.find((c) => c.name === envName);
		if (!hit)
			return {
				error: `${path}: no variable named ${envName} (present: ${namesOf(candidates)})`,
			};
		return { key: hit.value };
	}
	if (candidates.length === 1) return { key: candidates[0]?.value ?? "" };
	if (candidates.length === 0)
		return { error: `${path}: no key line found (file empty?)` };
	return {
		error: `${path}: ${candidates.length} variables (${namesOf(candidates)}) — select one with --env NAME (a spoke env file's first line is the ROOT key, never guessed)`,
	};
}

/** The candidate NAME list for failure lines — names only, never values. */
function namesOf(candidates: KeyCandidate[]): string {
	return candidates.map((c) => c.name ?? "<bare>").join(", ") || "none";
}

/** The store tail: refuse an existing target, atomic 0600 write, metadata. */
function storeKeyMintFile(minted: ServiceMint, outPath: string): void {
	if (lstatSync(outPath, { throwIfNoEntry: false })) {
		console.log(
			`hubctl mint-service-key: ${outPath} already exists — remove it first (a credential file is never silently replaced)`,
		);
		process.exit(1);
	}
	const tmp = join(
		dirname(outPath),
		`.${basename(outPath)}.tmp-${process.pid}`,
	);
	writeFileSync(tmp, `${minted.key}\n`, { mode: 0o600 });
	renameSync(tmp, outPath);
	console.log(
		`✓ minted ${minted.key_id ?? "?"} (${minted.scopes.join(",")}) expires_at=${minted.expires_at ?? null} → ${outPath} (0600, raw material never printed)`,
	);
}
