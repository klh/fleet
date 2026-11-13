#!/usr/bin/env bun
// scripts/bare-v1-evidence.ts — W3036 stage 3: the bare legacy /v1/*
// retirement evidence face (C530 verdict). Retirement of the unprefixed
// legacy LLM paths is keyed on ACTOR (credential/scope), NOT on lane=''
// request share alone: runner-scoped traffic (leaf model plane,
// <identityUrl>/v1/chat/completions with runner keys), admin faces,
// buckle-seed guest provider-import and /v1/fleet/whoami are lane-less BY
// DESIGN and never reach zero — they are EXCLUDED from the blocker set.
// What remains (proxy-scoped actors still riding bare /v1) is the blocker
// set: it must be empty before the legacy routes retire.
//
// Render: one TSV row per (actor, request_path) on lane='' + path LIKE
// '/v1/%', scope-classified; the verdict line names the distinct blocking
// actors. Exit 0 always (evidence, not a gate).
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";

const dbArg = process.argv[2] ?? process.env.BUCKLE_DB;
const dbPath =
	dbArg && dbArg !== "--"
		? dbArg
		: join(homedir(), ".claude", "local-llm", "buckle.db");

if (!existsSync(dbPath)) {
	console.error(`bare-v1-evidence: no ledger at ${dbPath} (pass a db path)`);
	process.exit(0);
}
const db = new Database(dbPath, { readonly: true });

const rows = db
	.query(
		`SELECT route_audit.actor AS actor, route_audit.request_path AS path,
		        COUNT(*) AS n, MAX(route_audit.ts) AS last_ts,
		        COALESCE(api_keys.scopes, '') AS scopes
		 FROM route_audit
		 LEFT JOIN api_keys ON api_keys.key_id = route_audit.actor
		 WHERE route_audit.lane = '' AND route_audit.request_path LIKE '/v1/%'
		 GROUP BY route_audit.actor, route_audit.request_path, api_keys.scopes
		 ORDER BY n DESC`,
	)
	.all() as { actor: string; path: string; n: number; last_ts: string; scopes: string }[];

/** C530: lane-less BY DESIGN — excluded from retirement evidence. */
const isByDesign = (scopes: string): boolean =>
	scopes
		.split(/[,\s]+/)
		.filter(Boolean)
		.some((s) => s.startsWith("buckle:runner:") || s.startsWith("buckle:admin:"));

const blockers = new Map<string, number>();
console.log("actor\tpath\trequests\tlast\tscopes\tclass");
for (const r of rows) {
	const byDesign =
		isByDesign(r.scopes) ||
		r.path === "/v1/fleet/whoami"; // infra hop, lane-less by design
	if (!byDesign && r.actor !== "")
		blockers.set(r.actor, (blockers.get(r.actor) ?? 0) + r.n);
	console.log(
		`${r.actor || "(anon)"}\t${r.path}\t${r.n}\t${r.last_ts}\t${r.scopes || "-"}\t${byDesign ? "by-design" : "BLOCKER"}`,
	);
}

if (rows.length === 0) {
	console.log("bare /v1 lane-less traffic: none recorded — retirable");
} else if (blockers.size === 0) {
	console.log(
		"bare /v1 lane-less traffic: only by-design (runner/admin/infra) — retirable",
	);
} else {
	console.log(
		`blockers: ${[...blockers.keys()].join(", ")} — legacy /v1 NOT retirable until these actors migrate to /w/<slug> (or named bases)`,
	);
}
