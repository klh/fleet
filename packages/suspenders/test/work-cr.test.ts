// test/work-cr.test.ts — W352 work delegation e2e over the W160/W193 CR
// channel, against a real buckle hub (in-process server). Origin half: the
// declare client lands a work-item CR (admin capability, idempotent on id).
// Spoke half: reconcileWorkCrs drives declared→delivered→applied from a
// pulled manifest, reconciles the item into an in-memory work graph
// (governor.db shape), and reports `failed` honestly when the graph write
// throws. Applied→verified stays probe-gated hub-side (no work@ probe —
// verified is never granted on faith, W160); the delegation terminus is
// `applied`.
import { describe, expect, test } from "bun:test";
import { startServer } from "../../buckle/src/server.ts";
import {
	declareWorkCr,
	ensureDelegatedItem,
	fetchCrQueue,
	openMemoryWorkGraph,
	reconcileWorkCrs,
	WORK_CR_ACTION,
	WORK_CR_TARGET_PREFIX,
} from "../hooks/lib/work-cr.ts";

const ROOT = "buckle-test-root";

async function startFed(): Promise<{ base: string; stop: () => void }> {
	const dir = `/tmp/w352-work-cr-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
	const policy = [
		"version: 1",
		"gateway:",
		"  num_retries: 1",
		"  allowed_fails: 3",
		"  cooldown_time: 30",
		"",
	].join("\n");
	const upstreams = [
		"version: 1",
		"groups:",
		"  glm-5.3-flash:",
		"    - url: http://127.0.0.1:8501",
		"      dialect: openai",
		"",
	].join("\n");
	await Bun.write(`${dir}.policy.yaml`, policy);
	await Bun.write(`${dir}.upstreams.yaml`, upstreams);
	const srv = startServer({
		port: 0,
		policyPath: `${dir}.policy.yaml`,
		upstreamsPath: `${dir}.upstreams.yaml`,
		dbPath: ":memory:",
		auth: { rootKey: ROOT },
	});
	return {
		base: `http://127.0.0.1:${srv.port}`,
		stop: () => srv.stop(true),
	};
}

async function issueKey(
	base: string,
	scopes: string[],
): Promise<{ key: string; keyId: string }> {
	const res = await fetch(`${base}/v1/admin/keys`, {
		method: "POST",
		headers: { authorization: `Bearer ${ROOT}` },
		body: JSON.stringify({ name: `w352-${Math.random().toString(36).slice(2, 6)}`, scopes }),
	});
	const out = (await res.json()) as { key: string };
	const keyId = new Bun.CryptoHasher("sha256").update(out.key).digest("hex").slice(0, 12);
	return { key: out.key, keyId };
}

function declareWork(
	base: string,
	key: string,
	id: string,
): Promise<Response> {
	return fetch(`${base}/federation/cr`, {
		method: "POST",
		headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
		body: JSON.stringify({
			id,
			action: WORK_CR_ACTION,
			target: `${WORK_CR_TARGET_PREFIX}W999`,
			payload: { title: "delegated item", description: "from the origin graph", priority: 3 },
			origin: { system: "suspenders", actor: "w352-lane" },
		}),
	});
}

interface ManifestView {
	cr_queue: Array<{
		id: string;
		state: string;
		claimed_by: string | null;
		note: string | null;
	}>;
}

async function manifestCRs(base: string, key: string): Promise<ManifestView["cr_queue"]> {
	const res = await fetch(`${base}/federation/policy-manifest`, {
		headers: { authorization: `Bearer ${key}` },
	});
	const body = (await res.json()) as ManifestView;
	return body.cr_queue;
}

describe("w352: declare half (origin)", () => {
	test("declareWorkCr lands a work CR (admin key, not spoke); idempotent on id", async () => {
		const fed = await startFed();
		const admin = await issueKey(fed.base, ["buckle:admin:WRITE_"]);
		const spec = {
			id: "wcr-W900",
			action: WORK_CR_ACTION,
			target: `${WORK_CR_TARGET_PREFIX}W900`,
			payload: { title: "write the sim harness", priority: 2 },
			origin: { system: "suspenders", actor: "w352-lane" },
		};
		const first = await declareWorkCr({ hubUrl: fed.base, adminKey: admin.key, spec });
		expect(first.ok).toBe(true);
		expect(first.status).toBe(201);
		expect(first.cr?.state).toBe("declared");
		const again = await declareWorkCr({ hubUrl: fed.base, adminKey: admin.key, spec });
		expect(again.ok).toBe(true);
		expect(again.cr?.state).toBe("declared");
		// a spoke key may NOT declare (the structural 403, W160)
		const spoke = await issueKey(fed.base, ["buckle:spoke:WRITE_"]);
		const denied = await declareWorkCr({ hubUrl: fed.base, adminKey: spoke.key, spec });
		expect(denied.ok).toBe(false);
		expect(denied.status).toBe(403);
		// admin list sees exactly one row
		const q = await fetchCrQueue(fed.base, admin.key);
		expect(q.filter((c) => c.id === "wcr-W900").length).toBe(1);
		fed.stop();
	});
});

describe("w352: reconcile half (spoke) — the e2e chain", () => {
	test("declared → delivered → applied; item lands READY in the spoke graph; provenance recorded", async () => {
		const fed = await startFed();
		const admin = await issueKey(fed.base, ["buckle:admin:WRITE_"]);
		const spoke = await issueKey(fed.base, ["buckle:spoke:WRITE_"]);
		const dec = await declareWork(fed.base, admin.key, "wcr-W910");
		expect(dec.status).toBe(201);
		const manifest = { cr_queue: await manifestCRs(fed.base, spoke.key) };
		expect(manifest.cr_queue.length).toBe(1);
		const graph = openMemoryWorkGraph();
		const r = await reconcileWorkCrs({
			manifest,
			db: graph,
			project: "spoke-project",
			hubUrl: fed.base,
			spokeKey: spoke.key,
			nowMs: 1_700_000_000_000,
		});
		expect(r.scanned).toBe(1);
		expect(r.delivered).toBe(1);
		expect(r.applied).toBe(1);
		expect(r.failed).toBe(0);
		expect(r.errors).toEqual([]);
		// hub state reports back: applied, claimed by THIS spoke's key
		const row = (await manifestCRs(fed.base, spoke.key)).find((c) => c.id === "wcr-W910");
		expect(row?.state).toBe("applied");
		expect(row?.claimed_by).toBe(spoke.keyId);
		// spoke graph: the item exists, claimable, with provenance
		const item = graph
			.query("SELECT * FROM work_items WHERE project = ? AND id = ?")
			.get("spoke-project", "wcr-W910") as Record<string, unknown>;
		expect(item.state).toBe("READY");
		expect(item.created_by).toBe("federation-cr");
		expect(String(item.title)).toBe("delegated item");
		expect(String(item.description)).toContain("from the origin graph");
		expect(String(item.description)).toContain("CR wcr-W910 from suspenders/w352-lane");
		expect(item.priority).toBe(3);
		const ev = graph
			.query("SELECT kind, source FROM events WHERE payload LIKE ?")
			.get("%wcr-W910%") as Record<string, unknown>;
		expect(ev.kind).toBe("work.added");
		expect(ev.source).toBe("federation-cr");
		fed.stop();
	});

	test("re-run converges: applied CR re-ensures the row, no duplicate, no 409 noise", async () => {
		const fed = await startFed();
		const spoke = await issueKey(fed.base, ["buckle:spoke:WRITE_"]);
		const admin = await issueKey(fed.base, ["buckle:admin:WRITE_"]);
		await declareWork(fed.base, admin.key, "wcr-W911");
		const manifest = { cr_queue: await manifestCRs(fed.base, spoke.key) };
		const graph = openMemoryWorkGraph();
		const first = await reconcileWorkCrs({
			manifest, db: graph, project: "p", hubUrl: fed.base, spokeKey: spoke.key,
		});
		expect(first.applied).toBe(1);
		const second = await reconcileWorkCrs({
			manifest: { cr_queue: await manifestCRs(fed.base, spoke.key) },
			db: graph, project: "p", hubUrl: fed.base, spokeKey: spoke.key,
		});
		expect(second.errors).toEqual([]);
		expect(second.applied).toBe(1); // re-ensured, no state churn
		const count = graph
			.query("SELECT COUNT(*) AS n FROM work_items WHERE project = ? AND id = ?")
			.get("p", "wcr-W911") as { n: number };
		expect(count.n).toBe(1);
		fed.stop();
	});

	test("stale manifest (state=declared, hub already delivered) converges without errors", async () => {
		const fed = await startFed();
		const spoke = await issueKey(fed.base, ["buckle:spoke:WRITE_"]);
		const admin = await issueKey(fed.base, ["buckle:admin:WRITE_"]);
		await declareWork(fed.base, admin.key, "wcr-W912");
		// a prior cycle already delivered this CR
		await fetch(`${fed.base}/federation/cr/wcr-W912/status`, {
			method: "POST",
			headers: { authorization: `Bearer ${spoke.key}`, "content-type": "application/json" },
			body: JSON.stringify({ state: "delivered" }),
		});
		const stale = { cr_queue: await manifestCRs(fed.base, spoke.key) };
		const graph = openMemoryWorkGraph();
		const r = await reconcileWorkCrs({
			manifest: stale, db: graph, project: "p", hubUrl: fed.base, spokeKey: spoke.key,
		});
		expect(r.errors).toEqual([]);
		expect(r.applied).toBe(1);
		const row = (await manifestCRs(fed.base, spoke.key)).find((c) => c.id === "wcr-W912");
		expect(row?.state).toBe("applied");
		fed.stop();
	});

	test("graph write failure reports `failed` back with the note", async () => {
		const fed = await startFed();
		const spoke = await issueKey(fed.base, ["buckle:spoke:WRITE_"]);
		const admin = await issueKey(fed.base, ["buckle:admin:WRITE_"]);
		await declareWork(fed.base, admin.key, "wcr-W913");
		const manifest = { cr_queue: await manifestCRs(fed.base, spoke.key) };
		const broken = {
			run: () => {
				throw new Error("graph locked");
			},
			query: () => {
				throw new Error("graph locked");
			},
		};
		const r = await reconcileWorkCrs({
			manifest, db: broken, project: "p", hubUrl: fed.base, spokeKey: spoke.key,
		});
		expect(r.failed).toBe(1);
		expect(r.errors.some((e) => e.includes("graph locked"))).toBe(true);
		const row = (await manifestCRs(fed.base, spoke.key)).find((c) => c.id === "wcr-W913");
		expect(row?.state).toBe("failed");
		expect(row?.note).toContain("graph locked");
		fed.stop();
	});

	test("no spoke token → skipped honestly, hub state untouched", async () => {
		const fed = await startFed();
		const spoke = await issueKey(fed.base, ["buckle:spoke:WRITE_"]);
		const admin = await issueKey(fed.base, ["buckle:admin:WRITE_"]);
		await declareWork(fed.base, admin.key, "wcr-W914");
		const manifest = { cr_queue: await manifestCRs(fed.base, spoke.key) };
		const graph = openMemoryWorkGraph();
		const r = await reconcileWorkCrs({
			manifest, db: graph, project: "p", hubUrl: fed.base, spokeKey: null,
		});
		expect(r.scanned).toBe(1);
		expect(r.skipped).toBe(1);
		expect(r.errors[0]).toContain("no spoke token");
		const row = (await manifestCRs(fed.base, spoke.key)).find((c) => c.id === "wcr-W914");
		expect(row?.state).toBe("declared");
		fed.stop();
	});

	test("ensureDelegatedItem: terminal skip + foreign actions never touch the graph", async () => {
		const graph = openMemoryWorkGraph();
		const made = ensureDelegatedItem(
			graph,
			"p",
			{
				id: "wcr-W915",
				action: "adopt-policy",
				target: "work@W915",
				declared_at: "2026-10-07T00:00:00Z",
				state: "declared",
			},
			1,
		);
		expect(made).toBe(true);
		const item = graph.query("SELECT * FROM work_items WHERE id = ?").get("wcr-W915") as Record<string, unknown>;
		expect(item.state).toBe("READY");
		expect(item.title).toBe("work@W915"); // target fallback when payload lacks a title
	});
});
