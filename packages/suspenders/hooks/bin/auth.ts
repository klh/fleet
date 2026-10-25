#!/usr/bin/env bun
// hooks/bin/auth.ts — W149 CLI issuance against the v8 identity tables.
//
//   auth.ts issue --actor A --class app-role|delegated [--team T]
//                 [--scopes s1,s2] [--name N] [--access-ttl-days N]
//                 [--refresh-ttl-days N] [--save BASE]
//   auth.ts revoke --jti J | --actor A | --team T
//   auth.ts list [--actor A]
//   auth.ts whoami --url URL --token-file BASE
//
// TTLs: 0 (or omitted flag semantics documented in --help) = forever
// (expires_at NULL). Default with NO ttl flags: access 30d, refresh NULL
// (rotate-until-infinity) — the user convention. The owner pair passes 0.
// Raw tokens NEVER print to stdout unless --show is passed; --save BASE
// writes ~/.claude/local-llm/buckle-<BASE>.token + .refresh (mode 600) and
// output shows fingerprints only.
import {
	fingerprint,
	issueTokens,
	loadKeyRing,
	revoke,
	rotateSigningKey,
} from "../lib/auth/auth.ts";
import { saveTokenFiles } from "../lib/auth/auth-client.ts";
import { openIdentity, openStore } from "../lib/govdb/govdb.ts";
import {
	defineVerb,
	type Parsed,
	runCli,
	type VerbSpec,
} from "../lib/verb-kit.ts";

const days = (v: string | null): number | null | undefined => {
	if (v === null) return undefined; // flag absent
	const n = Number(v);
	return Number.isFinite(n) && n >= 0 ? n * 86400_000 : null;
};
function cmdIssue(p: Parsed): number {
	const actor = p.flag("--actor");
	const cls = p.flag("--class") ?? "app-role";
	if (!actor) {
		console.error("--actor is required");
		return 2;
	}
	if (!["app-role", "delegated"].includes(cls)) {
		console.error("--class must be app-role or delegated");
		return 2;
	}
	const scopes = (p.flag("--scopes") ?? "buckle:admin")
		.split(",")
		.map((s) => s.trim())
		.filter(Boolean);
	const aTtl = days(p.flag("--access-ttl-days"));
	const rTtl = days(p.flag("--refresh-ttl-days"));
	const pair = issueTokens(openIdentity(), {
		actor,
		team: p.flag("--team") ?? null,
		token_class: cls as "app-role" | "delegated",
		scopes,
		name: p.flag("--name") ?? null,
		accessTtlMs: aTtl === undefined ? 30 * 86400_000 : aTtl,
		refreshTtlMs: rTtl === undefined ? null : rTtl,
		via: "cli:auth.ts",
	});
	const save = p.flag("--save");
	if (save)
		saveTokenFiles(save, { access: pair.access, refresh: pair.refresh });
	console.log(`issued pair for ${actor} (${cls})`);
	console.log(
		`  access  jti ${pair.jti}  exp ${pair.expires_at ?? "forever"}  ${fingerprint(pair.access)}`,
	);
	console.log(
		`  refresh jti ${pair.refresh_jti}  exp ${pair.refresh_expires_at ?? "forever"}  ${fingerprint(pair.refresh)}`,
	);
	if (save)
		console.log(
			`  saved   buckle-${save}.token + .refresh in the local-llm secrets home (0600)`,
		);
	if (p.flag("--show")) {
		console.log(`ACCESS:\n${pair.access}`);
		console.log(`REFRESH:\n${pair.refresh}`);
	}
	return 0;
}
function cmdRevoke(p: Parsed): number {
	const sel = {
		jti: p.flag("--jti"),
		actor: p.flag("--actor"),
		team: p.flag("--team"),
	};
	if (!sel.jti && !sel.actor && !sel.team) {
		console.error("revoke needs --jti, --actor, or --team");
		return 2;
	}
	const out = revoke(
		openIdentity(),
		sel,
		"cli:auth.ts",
		`cli:${process.env.USER ?? "unknown"}`,
		openStore(),
	);
	console.log(
		`revoked ${out.changes} token row(s) (${sel.jti ? `jti=${sel.jti}` : sel.actor ? `actor=${sel.actor}` : `team=${sel.team}`})`,
	);
	return 0;
}

function cmdList(p: Parsed): number {
	void p;
	const store = openIdentity();
	const actor = p.flag("--actor");
	const where = actor ? "WHERE actor = ?" : "";
	const rows = store
		.query(
			`SELECT key_id, actor, team, token_type, parent_key_id, scopes, expires_at, rotated_at, revoked_at, created_at FROM api_keys ${where} ORDER BY created_at DESC LIMIT 100`,
		)
		.all(...(actor ? [actor] : [])) as {
		key_id: string;
		actor: string | null;
		team: string | null;
		token_type: string;
		parent_key_id: string | null;
		scopes: string | null;
		expires_at: number | null;
		rotated_at: number | null;
		revoked_at: number | null;
		created_at: number;
	}[];
	console.log(
		["key_id", "actor", "type", "expires", "state", "scopes"].join("\t"),
	);
	for (const r of rows) {
		const state = r.revoked_at
			? "revoked"
			: r.rotated_at
				? "rotated"
				: "active";
		console.log(
			[
				r.key_id.slice(0, 8),
				r.actor,
				r.token_type,
				r.expires_at ? new Date(r.expires_at).toISOString() : "forever",
				state,
				r.scopes ?? "",
			].join("\t"),
		);
	}
	return 0;
}
async function cmdWhoami(p: Parsed): Promise<number> {
	const url = p.flag("--url");
	const base = p.flag("--token-file");
	if (!url || !base) {
		console.error("whoami needs --url and --token-file");
		return 2;
	}
	const { loadTokenFiles } = await import("../lib/auth/auth-client.ts");
	const pair = loadTokenFiles(base);
	if (!pair) {
		console.error(
			`no buckle-${base}.token/.refresh in the local-llm secrets home`,
		);
		return 2;
	}
	const r = await fetch(`${url}/auth/whoami`, {
		headers: { authorization: `Bearer ${pair.access}` },
	});
	const b = (await r.json()) as Record<string, unknown>;
	console.log(JSON.stringify(b, null, 2));
	return r.ok ? 0 : 1;
}

function cmdKeyring(p: Parsed): number {
	void p;
	const ring = loadKeyRing();
	if (!ring.length) {
		console.log(
			"no ring yet (legacy single-key deployment) — run `auth.ts rotate-key` to create one",
		);
		return 0;
	}
	console.log(["kid", "created", "state"].join("\t"));
	for (const k of ring) {
		const state =
			k.retire_at === null
				? "CURRENT"
				: k.retire_at > Date.now()
					? `grace until ${new Date(k.retire_at).toISOString()}`
					: "dead";
		console.log(
			[k.kid, new Date(k.created_at).toISOString(), state].join("\t"),
		);
	}
	return 0;
}

function cmdRotateKey(p: Parsed): number {
	void p;
	const h = Number(p.flag("--grace-hours") ?? "24");
	if (!Number.isFinite(h) || h < 0) {
		console.error("--grace-hours must be a number >= 0");
		return 2;
	}
	const out = rotateSigningKey(h * 3_600_000);
	console.log(`signing key rotated: new ${out.kid}`);
	if (out.retired_kid) console.log(`  retired ${out.retired_kid}`);
	console.log(
		out.graceUntil === null
			? "  grace 0 (emergency): every old access token is dead now — clients re-auth via /auth/refresh"
			: `  old key in grace until ${new Date(out.graceUntil).toISOString()} — old tokens verify till then, then clients self-heal via /auth/refresh`,
	);
	return 0;
}

const VERBS: VerbSpec[] = [
	defineVerb({
		name: "issue",
		usage:
			"usage: auth issue --actor A --class app-role|delegated [--team T] [--scopes s1,s2] [--name N] [--access-ttl-days N] [--refresh-ttl-days N] [--save BASE] [--show]",
		flags: [
			"--actor",
			"--class",
			"--team",
			"--scopes",
			"--name",
			"--access-ttl-days",
			"--refresh-ttl-days",
			"--save",
		],
		switches: ["--show"],
		reqFlags: ["--actor"],
	}),
	defineVerb({
		name: "revoke",
		usage: "usage: auth revoke --jti J | --actor A | --team T",
		flags: ["--jti", "--actor", "--team"],
	}),
	defineVerb({
		name: "list",
		usage: "usage: auth list [--actor A]",
		flags: ["--actor"],
	}),
	defineVerb({
		name: "whoami",
		usage: "usage: auth whoami --url URL --token-file BASE",
		flags: ["--url", "--token-file"],
		reqFlags: ["--url", "--token-file"],
	}),
	defineVerb({
		name: "keyring",
		usage: "usage: auth keyring — signing keys: CURRENT / grace / dead",
	}),
	defineVerb({
		name: "rotate-key",
		usage:
			"usage: auth rotate-key [--grace-hours N]   (0 = emergency kill, default 24)",
		flags: ["--grace-hours"],
	}),
];

const commands: Record<string, (p: Parsed) => number | Promise<number>> = {
	issue: cmdIssue,
	revoke: cmdRevoke,
	list: cmdList,
	whoami: cmdWhoami,
	keyring: cmdKeyring,
	"rotate-key": cmdRotateKey,
};

await runCli({
	prog: "auth",
	about: "auth — W149 CLI token issuance against the v8 identity tables.",
	verbs: VERBS,
	dispatch: (name, p) => commands[name](p),
});
