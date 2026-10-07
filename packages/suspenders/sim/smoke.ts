// sim/smoke.ts — W162 full-system sim smoke chain. Hub = Docker compose trio,
// spoke = this host. Line-per-check PASS/RED/ERR output.
//   exit 0 = all checks PASS
//   exit 2 = one or more RED (federation surface awaiting a lane) — expected
//   exit 1 = harness error (hub unreachable / crash) — fix compose first
// Laws honored: streams-over-buffers (capped stream reads, no slurping),
// http-citizenship (the smoke CHECKS the standard's headers; missing = RED).
//
// Env it needs (defaults match sim/.env.example + sim/spoke-profile.env):
//   SIM_BUCKLE_URL   default http://127.0.0.1:17001
//   SIM_BOARD_URL    default http://127.0.0.1:17002
//   SIM_STORE_URL    default http://127.0.0.1:17003
//   SIM_BELT_URL     default http://127.0.0.1:17004
//   SIM_SPOKE_PROFILE default <this dir>/spoke-profile.env

import { getJson, isRecord, readCapped } from "../hooks/lib/http.ts";

// W352: the work-delegation e2e check declares with a real admin capability
// (operator-wired, machine config — the smoke never guesses credentials)
import {
	declareWorkCr,
	openMemoryWorkGraph,
	reconcileWorkCrs,
	WORK_CR_ACTION,
	WORK_CR_TARGET_PREFIX,
} from "../hooks/lib/work-cr.ts";

const SIM_E2E_ADMIN_KEY = process.env.SIM_E2E_ADMIN_KEY ?? "";

type Outcome = "PASS" | "RED" | "ERR";
interface Row {
	name: string;
	out: Outcome;
	note: string;
}
const rows: Row[] = [];

function report(name: string, out: Outcome, note: string): void {
	rows.push({ name, out, note });
	console.log(`[${out.toLowerCase()}] ${name} — ${note}`);
}

const SIM_BUCKLE_URL = process.env.SIM_BUCKLE_URL ?? "http://127.0.0.1:17001";
const SIM_BOARD_URL = process.env.SIM_BOARD_URL ?? "http://127.0.0.1:17002";
const SIM_STORE_URL = process.env.SIM_STORE_URL ?? "http://127.0.0.1:17003";
const SIM_BELT_URL = process.env.SIM_BELT_URL ?? "http://127.0.0.1:17004";
const SIM_SPOKE_PROFILE =
	process.env.SIM_SPOKE_PROFILE ??
	new URL("./spoke-profile.env", import.meta.url).pathname;

console.log(
	"sim-smoke env needed: SIM_BUCKLE_URL SIM_BOARD_URL SIM_STORE_URL SIM_BELT_URL SIM_SPOKE_PROFILE",
);

type Status = { ok: boolean; status: number; service?: string };

async function probeStatus(base: string, path: string): Promise<Status> {
	try {
		const { status, body } = await getJson(`${base}${path}`);
		const svc = isRecord(body) ? String(body.service ?? "") : "";
		return { ok: status === 200, status, service: svc };
	} catch (e) {
		console.log(
			`[err ] hub unreachable at ${base} (${String(e)}) — docker compose up -d first`,
		);
		process.exit(1);
	}
}

// (a) hub healthy
const buckle = await probeStatus(SIM_BUCKLE_URL, "/status");
report(
	"hub/buckle-hub-status",
	buckle.ok ? "PASS" : "ERR",
	`/status ${String(buckle.status)} service=${buckle.service ?? "?"}`,
);

const board = await probeStatus(SIM_BOARD_URL, "/status");
report(
	"hub/board-hub-status",
	board.ok ? "PASS" : "ERR",
	`/status ${String(board.status)} service=${board.service ?? "?"}`,
);
const store = await probeStatus(SIM_STORE_URL, "/status");
report(
	"hub/store-hub-status",
	store.ok ? "PASS" : "ERR",
	`/status ${String(store.status)} service=${store.service ?? "?"}`,
);
const belt = await probeStatus(SIM_BELT_URL, "/api/status");
report(
	"hub/belt-hub-status",
	belt.ok ? "PASS" : "ERR",
	`/api/status ${String(belt.status)} (central belt dashboard)`,
);

// (b) hub issues a token
let hubAccess: string | null = null;
try {
	const tok = await getJson(`${SIM_STORE_URL}/auth/token`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({
			actor: "w162-sim",
			name: "w162-sim-smoke",
			scopes: ["read:*"],
			access_ttl_seconds: 300,
		}),
	});
	const tokBody = isRecord(tok.body) ? tok.body : {};
	const access = tokBody.access_token;
	if (tok.status === 200 && typeof access === "string") {
		hubAccess = access;
		report(
			"token/issue-hs256",
			"PASS",
			`store-hub /auth/token 200 (jti=${String(tokBody.jti)})`,
		);
	} else {
		report(
			"token/issue-hs256",
			"RED",
			`store-hub /auth/token ${String(tok.status)} — issuance is admin-gated (W149); sim bootstrap lands with W156 identity.db`,
		);
	}
} catch (e) {
	report(
		"token/issue-hs256",
		"ERR",
		`store-hub /auth/token unreachable: ${String(e)}`,
	);
}

// whoami round-trip with the issued token
if (hubAccess !== null) {
	try {
		const who = await getJson(`${SIM_STORE_URL}/auth/whoami`, {
			headers: { authorization: `Bearer ${hubAccess}` },
		});
		report(
			"token/whoami",
			who.status === 200 ? "PASS" : "RED",
			`/auth/whoami ${String(who.status)} (issued token validated by hub)`,
		);
	} catch (e) {
		report("token/whoami", "ERR", String(e));
	}
} else {
	report(
		"token/whoami",
		"RED",
		"skipped — no token issued (see token/issue-hs256)",
	);
}

// (b2) JWKS: hub-only asymmetric keys (owner law) — RS256 + JWKS serve is W156
for (const [name, url] of [
	["federation/jwks-buckle", `${SIM_BUCKLE_URL}/.well-known/jwks.json`],
	["federation/jwks-store", `${SIM_STORE_URL}/.well-known/jwks.json`],
] as const) {
	try {
		const jw = await getJson(url);
		const keys =
			isRecord(jw.body) && Array.isArray(jw.body.keys)
				? jw.body.keys.length
				: 0;
		if (jw.status === 200 && keys > 0) {
			report(
				name,
				"PASS",
				`JWKS 200, ${String(keys)} key(s) — W156 surface live`,
			);
		} else {
			report(
				name,
				"RED",
				`${url.split("//")[1]} → ${String(jw.status)} — awaiting W156 (identity.db, RS256 JWKS)`,
			);
		}
	} catch (e) {
		report(name, "ERR", String(e));
	}
}

// (c) spoke-config validation — spoke = this host; the sim profile points the
// spoke's policy-pull / JWKS / CR-check at the hub ports
const prof = await Bun.file(SIM_SPOKE_PROFILE)
	.text()
	.then((t) => t)
	.catch(() => null);
if (prof === null) {
	report("spoke/profile", "ERR", `missing sim profile: ${SIM_SPOKE_PROFILE}`);
} else {
	const hubVars = [...prof.matchAll(/^SIM_HUB_\w+=\S+$/gm)];
	report(
		"spoke/profile",
		hubVars.length >= 4 ? "PASS" : "RED",
		`${SIM_SPOKE_PROFILE} parsed, ${String(hubVars.length)} SIM_HUB_* vars (need 4)`,
	);
}

// (c2) spoke pulls the hub policy manifest — W154
let manifest: Record<string, unknown> | null = null;
try {
	const man = await getJson(`${SIM_BUCKLE_URL}/federation/policy-manifest`);
	if (man.status === 200 && isRecord(man.body)) {
		manifest = man.body;
		report(
			"federation/policy-manifest",
			"PASS",
			`200, version=${String(manifest.version)}`,
		);
	} else {
		report(
			"federation/policy-manifest",
			"RED",
			`${String(man.status)} — awaiting W154 (hub policy distribution)`,
		);
	}
} catch (e) {
	report("federation/policy-manifest", "ERR", String(e));
}

// (d) CR lifecycle probe — rides the W154 payload (W160): declared →
// delivered → applied → verified → reported-up
if (manifest !== null && Array.isArray(manifest.cr_queue)) {
	const q = manifest.cr_queue.length;
	report(
		"federation/cr-queue",
		"PASS",
		`manifest.cr_queue present, ${String(q)} entr(y|ies)`,
	);
} else {
	report(
		"federation/cr-queue",
		"RED",
		"no cr_queue in policy manifest — awaiting W160 (CR channel)",
	);
}

// (d2) the W352 e2e run: credential-gated, temp spoke key revoked after
if (SIM_E2E_ADMIN_KEY.length === 0) {
	report(
		WORK_CR_E2E_TAG,
		"RED",
		"no SIM_E2E_ADMIN_KEY wired — the declare leg needs buckle:admin:WRITE_ (operator env)",
	);
} else {
	try {
		const minted = await workCrE2eMint();
		const d = await workCrE2eDeclare();
		const r = await workCrE2eReconcile(minted.key, d.crId);
		// revoke the temp spoke key before judging (cleanup always runs)
		await fetch(`${SIM_BUCKLE_URL}/v1/admin/keys/${minted.keyId}/revoke`, {
			method: "POST",
			headers: { authorization: `Bearer ${SIM_E2E_ADMIN_KEY}` },
		}).then((res) => readCapped(res));
		const back = d.ok && r.applied === 1 && r.hubState === "applied";
		report(
			WORK_CR_E2E_TAG,
			back ? "PASS" : "RED",
			back
				? `declare → reconcile → applied round-trip on the composed hub (cr=${d.crId}, temp spoke key revoked)`
				: `chain did not converge: declared=${String(d.ok)} applied=${String(r.applied)} hub_state=${r.hubState}${r.errors.length > 0 ? ` errors=${r.errors.join("; ")}` : ""}`,
		);
	} catch (e) {
		report(WORK_CR_E2E_TAG, "ERR", String(e));
	}
}

// (d2) W352 work-delegation e2e: declare → spoke reconcile → status back.
// Credential-gated (SIM_E2E_ADMIN_KEY): the sim hub mints its root INSIDE
// the hub-secrets volume and never prints it, so the operator passes one
// admin capability; the smoke mints a TEMPORARY spoke key for the status
// reports and revokes it after (test keys are never left behind).
const WORK_CR_E2E_TAG = "federation/work-cr-e2e";

/** Temp spoke key for the report leg — minted and revoked within the run. */
async function workCrE2eMint(): Promise<{ keyId: string; key: string }> {
	const res = await fetch(`${SIM_BUCKLE_URL}/v1/admin/keys`, {
		method: "POST",
		headers: {
			authorization: `Bearer ${SIM_E2E_ADMIN_KEY}`,
			"content-type": "application/json",
		},
		body: JSON.stringify({
			name: "w352-sim-spoke",
			scopes: ["buckle:spoke:WRITE_"],
		}),
	});
	const body = await readCapped(res);
	return {
		keyId: String((body as Record<string, unknown>).key_id),
		key: String((body as Record<string, unknown>).key),
	};
}

/** Pull the hub CR queue as the spoke (spoke:READ_ rides the manifest). */
async function workCrE2ePull(
	spokeKey: string,
): Promise<Array<Record<string, unknown>>> {
	const r = await getJson(`${SIM_BUCKLE_URL}/federation/policy-manifest`, {
		headers: { authorization: `Bearer ${spokeKey}` },
	});
	const b = r.body;
	return isRecord(b) && Array.isArray(b.cr_queue)
		? (b.cr_queue as Array<Record<string, unknown>>)
		: [];
}

/** Declare leg: one work CR as the origin (admin capability). */
async function workCrE2eDeclare(): Promise<{ crId: string; ok: boolean }> {
	const crId = `wcr-sim-${Date.now().toString(36)}`;
	const out = await declareWorkCr({
		hubUrl: SIM_BUCKLE_URL,
		adminKey: SIM_E2E_ADMIN_KEY,
		spec: {
			id: crId,
			action: WORK_CR_ACTION,
			target: `${WORK_CR_TARGET_PREFIX}W352`,
			payload: {
				title: "w352 sim delegation",
				description: "sim smoke: declare → reconcile → status back",
			},
			origin: { system: "suspenders", actor: "w352-sim" },
		},
	});
	return { crId, ok: out.ok };
}

/** Reconcile leg: pull → reconcile (throwaway in-memory graph — the smoke
 *  never writes the host governor.db) → re-pull, report the hub row state. */
async function workCrE2eReconcile(
	spokeKey: string,
	crId: string,
): Promise<{
	applied: number;
	hubState: string;
	errors: string[];
}> {
	const rec = await reconcileWorkCrs({
		manifest: { cr_queue: await workCrE2ePull(spokeKey) },
		db: openMemoryWorkGraph(),
		project: "sim-work-cr",
		hubUrl: SIM_BUCKLE_URL,
		spokeKey,
	});
	const row = (await workCrE2ePull(spokeKey)).find((c) => c.id === crId);
	return {
		applied: rec.applied,
		hubState: String(row?.state ?? "missing"),
		errors: rec.errors,
	};
}

// (e) echo menu — hub entitlement payload shapes the spoke menu (W154 echo)
try {
	const ent = await getJson(`${SIM_BUCKLE_URL}/federation/entitlements`);
	if (
		ent.status === 200 &&
		isRecord(ent.body) &&
		Array.isArray(ent.body.models)
	) {
		report(
			"federation/echo-menu",
			"PASS",
			`200, ${String(ent.body.models.length)} hub-entitled models`,
		);
	} else {
		report(
			"federation/echo-menu",
			"RED",
			`${String(ent.status)} — awaiting W154 echo menu (hub entitlement payload)`,
		);
	}
} catch (e) {
	report("federation/echo-menu", "ERR", String(e));
}

// http-citizenship (docs/design/http-citizenship.md) — the smoke CHECKS the
// standard and marks RED where a hub surface does not meet it yet (W155)
for (const [name, base] of [
	["citizenship/405-allow-buckle", SIM_BUCKLE_URL],
	["citizenship/405-allow-board", SIM_BOARD_URL],
	["citizenship/405-allow-store", SIM_STORE_URL],
	["citizenship/405-allow-belt", SIM_BELT_URL],
] as const) {
	try {
		const res = await fetch(`${base}/status`, { method: "DELETE" });
		await readCapped(res);
		if (res.status === 405) {
			report(
				name,
				res.headers.get("allow") ? "PASS" : "RED",
				`405 + Allow${res.headers.get("allow") ? "" : " MISSING"}`,
			);
		} else {
			report(
				name,
				"RED",
				`DELETE /status → ${String(res.status)} (want 405+Allow)`,
			);
		}
	} catch (e) {
		report(name, "ERR", String(e));
	}
}

// OPTIONS → 204 + Allow
try {
	const res = await fetch(`${SIM_BUCKLE_URL}/status`, { method: "OPTIONS" });
	await readCapped(res);
	if (res.status === 204 && res.headers.get("allow") !== null) {
		report("citizenship/options-204", "PASS", "204 + Allow");
	} else {
		report(
			"citizenship/options-204",
			"RED",
			`OPTIONS /status → ${String(res.status)} (want 204 + Allow)`,
		);
	}
} catch (e) {
	report("citizenship/options-204", "ERR", String(e));
}

// 401 → WWW-Authenticate (proxy-class surface on buckle without creds)
try {
	const res = await fetch(`${SIM_BUCKLE_URL}/v1/chat/completions`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: "{}",
	});
	await readCapped(res);
	if (res.status === 401) {
		const www = res.headers.get("www-authenticate");
		report(
			"citizenship/401-www-auth",
			www !== null ? "PASS" : "RED",
			www !== null
				? `401 + WWW-Authenticate: ${www}`
				: "401 MISSING WWW-Authenticate — awaiting W155",
		);
	} else {
		report(
			"citizenship/401-www-auth",
			"RED",
			`POST /v1/chat/completions → ${String(res.status)} (want 401)`,
		);
	}
} catch (e) {
	report("citizenship/401-www-auth", "ERR", String(e));
}

// 401 body: problem+json with the stable buckle code (http-citizenship)
try {
	const res = await fetch(`${SIM_BUCKLE_URL}/v1/chat/completions`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: "{}",
	});
	const { text } = await readCapped(res);
	const ct = res.headers.get("content-type") ?? "";
	let code = "";
	if (res.status === 401 && ct.startsWith("application/problem+json")) {
		try {
			code = String((JSON.parse(text) as { code?: unknown }).code ?? "");
		} catch {}
	}
	report(
		"citizenship/problem-json-buckle",
		code === "buckle.auth_missing" ? "PASS" : "RED",
		code === "buckle.auth_missing"
			? `401 problem+json, code=${code}`
			: `${String(res.status)} ct=${ct || "absent"} code=${code || "absent"} — awaiting W155.2`,
	);
} catch (e) {
	report("citizenship/problem-json-buckle", "ERR", String(e));
}

// ETag + If-None-Match → 304 on GET-able resources (W155)
try {
	const r1 = await fetch(`${SIM_BUCKLE_URL}/status`);
	await readCapped(r1);
	const etag = r1.headers.get("etag");
	if (r1.status === 200 && etag !== null) {
		const r2 = await fetch(`${SIM_BUCKLE_URL}/status`, {
			headers: { "if-none-match": etag },
		});
		await readCapped(r2);
		report(
			"citizenship/etag-304",
			r2.status === 304 ? "PASS" : "RED",
			`ETag ${etag}, If-None-Match → ${String(r2.status)} (want 304)`,
		);
	} else {
		report(
			"citizenship/etag-304",
			"RED",
			`no ETag on GET /status — awaiting W155`,
		);
	}
} catch (e) {
	report("citizenship/etag-304", "ERR", String(e));
}

// Cache-Control: no-store on /auth/* + rate-limit trio on authenticated API
if (hubAccess !== null) {
	try {
		const res = await getJson(`${SIM_STORE_URL}/auth/whoami`, {
			headers: { authorization: `Bearer ${hubAccess}` },
		});
		const cc = res.headers.get("cache-control");
		report(
			"citizenship/cache-control",
			cc?.includes("no-store") === true ? "PASS" : "RED",
			`Cache-Control: ${cc ?? "absent"} (want no-store)`,
		);
	} catch (e) {
		report("citizenship/cache-control", "ERR", String(e));
	}
	try {
		const res = await getJson(`${SIM_STORE_URL}/auth/whoami`, {
			headers: { authorization: `Bearer ${hubAccess}` },
		});
		const trio =
			res.headers.get("ratelimit-limit") !== null &&
			res.headers.get("ratelimit-remaining") !== null &&
			res.headers.get("ratelimit-reset") !== null;
		report(
			"citizenship/rate-trio",
			trio ? "PASS" : "RED",
			trio
				? "RateLimit-Limit/Remaining/Reset present on authenticated API"
				: "rate trio absent on authenticated API — awaiting W155",
		);
	} catch (e) {
		report("citizenship/rate-trio", "ERR", String(e));
	}
}

// summary — exit 0 all green, 2 = REDs (expected), 1 = harness error
const pass = rows.filter((r) => r.out === "PASS").length;
const red = rows.filter((r) => r.out === "RED").length;
const err = rows.filter((r) => r.out === "ERR").length;
console.log(
	`summary: ${String(pass)} pass, ${String(red)} red, ${String(err)} err — reds are honest "awaiting W154/W155/W156/W160" states, not crashes`,
);
if (err > 0) process.exit(1);
if (red > 0) process.exit(2);
process.exit(0);
