// W2256: denial-audit provenance for count_tokens no_route vs provider-pin
// filtering — the two refusals share error_code=no_route, so the audit row's
// requested_group/request_path/allow_cross/provider_pin are the discriminator.
// Also proves the schema heal preserves pre-W2256 databases (NULL = legacy).
import { Database } from "bun:sqlite";
import { expect, test } from "@playwright/test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../src/handlers.ts";
import { Ledger } from "../src/ledger.ts";
import type { Deployment, UpstreamPool } from "../src/upstreams.ts";
import { testDeps } from "./deps.ts";

const GROUP = "denial-audit-model";

function poolOf(deployments: Array<Omit<Deployment, "group">>): UpstreamPool {
	return {
		groups: () => [GROUP],
		deployments: (group) =>
			group === GROUP ? deployments.map((dep) => ({ ...dep, group })) : [],
	};
}

function countRequest(pin = false): Request {
	return new Request(
		`http://127.0.0.1:4101${pin ? "/zai" : ""}/anthropic/v1/messages/count_tokens?client=probe`,
		{
			method: "POST",
			body: JSON.stringify({
				model: GROUP,
				messages: [{ role: "user", content: "count me" }],
			}),
		},
	);
}

test.describe("denial audit provenance @api", () => {
	test("unconfigured-group count_tokens refusal carries the requested group and canonical path", async () => {
		const app = testDeps(poolOf([]));
		const res = await createApp(app).fetch(countRequest());
		expect(res.status).toBe(503);
		const rows = app.ledger.requestsRead({ limit: 5 });
		expect(rows.length).toBe(1);
		const row = rows[0];
		// the live incident: candidates_seen=0 but requested_group was NULL —
		// now the refusal names what it asked for
		expect(row.error_code).toBe("no_route");
		expect(row.candidates_seen).toBe(0);
		expect(row.requested_group).toBe(GROUP);
		// canonical path only — the ?client=probe query never rides
		expect(row.request_path).toBe("/v1/messages/count_tokens");
		expect(row.provider_pin).toBeNull();
		expect(row.allow_cross).toBe(0);
		app.ledger.close();
	});

	test("provider-pin filtering refuses with the pin on the row — same code, different provenance", async () => {
		const deps = testDeps(
			poolOf([
				{
					url: "http://127.0.0.1:1",
					dialect: "openai",
					adapter: "openai-compat",
				},
			]),
		);
		const res = await createApp(deps).fetch(countRequest(true));
		expect(res.status).toBe(503);
		const rows = deps.ledger.requestsRead({ limit: 5 });
		expect(rows.length).toBe(1);
		const row = rows[0];
		expect(row.error_code).toBe("no_route");
		expect(row.requested_group).toBe(GROUP);
		expect(row.request_path).toBe("/v1/messages/count_tokens");
		// the discriminator: the named-base pin that scoped the pool to zero
		expect(row.provider_pin).toBe("zai");
		expect(row.allow_cross).toBe(0);
		deps.ledger.close();
	});

	test("oversized group names bound to a safe audit token, never raw", async () => {
		const huge = `${"g".repeat(400)}`;
		const deps = testDeps(poolOf([]));
		const res = await createApp(deps).fetch(
			new Request("http://127.0.0.1:4101/anthropic/v1/messages/count_tokens", {
				method: "POST",
				body: JSON.stringify({ model: huge, messages: [] }),
			}),
		);
		expect(res.status).toBe(503);
		const row = deps.ledger.requestsRead({ limit: 5 })[0];
		expect(row.requested_group).toBe("g".repeat(128));
		expect(row.requested_group.length).toBe(128);
		deps.ledger.close();
	});
});

test.describe("schema heal preserves existing DBs @api", () => {
	test("a pre-W2256 route_audit heals its columns and keeps every legacy row", () => {
		const dir = mkdtempSync(join(tmpdir(), "buckle-w2256-"));
		const dbPath = join(dir, "legacy.db");
		// a pre-W2256 database: the full W1265-era audit shape WITHOUT the
		// three new provenance columns (the honest old-DB cut point)
		const raw = new Database(dbPath, { create: true });
		raw.exec(`CREATE TABLE route_audit (
			rid TEXT PRIMARY KEY,
			trace_id TEXT,
			ts TEXT NOT NULL,
			actor TEXT NOT NULL DEFAULT '',
			lane TEXT NOT NULL DEFAULT '',
			dialect TEXT NOT NULL DEFAULT '',
			hint TEXT NOT NULL DEFAULT '',
			candidates_seen INTEGER NOT NULL DEFAULT 0,
			candidates_top TEXT NOT NULL DEFAULT '',
			target_kind TEXT, target_host TEXT, target_port INTEGER, target_model TEXT,
			decision TEXT NOT NULL DEFAULT '',
			latency_class TEXT NOT NULL DEFAULT 'unproven',
			tier TEXT NOT NULL DEFAULT '',
			allow_cloud INTEGER NOT NULL DEFAULT 0,
			error_code TEXT,
			why TEXT NOT NULL DEFAULT '',
			status INTEGER, duration_ms INTEGER, ok INTEGER, err TEXT,
			attempts INTEGER,
			cache_r INTEGER, cache_c INTEGER, cache_reported INTEGER,
			cache_c_reported INTEGER,
			in_tok INTEGER, out_tok INTEGER,
			cost_usd REAL,
			rate_version TEXT NOT NULL DEFAULT '',
			hop TEXT,
			traffic_kind TEXT,
			repo_hash TEXT, account_tier TEXT, key_name TEXT,
			requested_group TEXT, requested_effort TEXT,
			served_model TEXT, served_provider TEXT,
			served_provider_profile TEXT, served_evidence TEXT
		)`);
		raw.run(
			"INSERT INTO route_audit (rid, ts, requested_group, decision) VALUES ('legacy-1', '2026-01-01T00:00:00.000Z', 'old-group', 'denied')",
		);
		raw.close();
		// opening the Ledger heals the schema in place — no row lost
		const ledger = new Ledger(dbPath);
		const rows = ledger.requestsRead({ limit: 10 });
		expect(rows.length).toBe(1);
		expect(rows[0].rid).toBe("legacy-1");
		// legacy rows read NULL on the new columns — honest unknown, never faked
		expect(rows[0].request_path).toBeNull();
		expect(rows[0].allow_cross).toBeNull();
		expect(rows[0].provider_pin).toBeNull();
		// and a fresh denial on the healed DB writes the full provenance
		ledger.auditDecision({
			rid: "fresh-1",
			ts: new Date().toISOString(),
			actor: "probe",
			lane: "",
			dialect: "anthropic",
			hint: "",
			candidates_seen: 0,
			candidates_top: "",
			target_kind: null,
			target_host: null,
			target_port: null,
			target_model: null,
			decision: "errored",
			latency_class: "unproven",
			tier: "",
			allow_cloud: false,
			error_code: "no_route",
			why: "healed-db probe",
			requested_group: GROUP,
			request_path: "/v1/messages/count_tokens",
			allow_cross: false,
			provider_pin: null,
		});
		const after = ledger.requestsRead({ limit: 10 });
		expect(after.length).toBe(2);
		expect(after[0].rid).toBe("fresh-1");
		expect(after[0].request_path).toBe("/v1/messages/count_tokens");
		expect(after[0].allow_cross).toBe(0);
		ledger.close();
		rmSync(dir, { recursive: true, force: true });
	});
});
