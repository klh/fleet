// test/gov-federation-usage.test.ts — W171 federation phase 3 e2e: the
// aggregate self-report seam. Default OFF (no policy block = no manifest
// rule + hub refuses ingests), per-team opt-in rides the manifest, strict
// allowlist validation, structural private-domain guard, idempotent
// upsert, admin-only rollup read, class contract with the spoke suite.
import { describe, expect, test } from "bun:test";
import { GROUPS } from "../../suspenders/hooks/lib/usage.ts";
import {
	MODEL_CLASSES,
	validateSelfReport,
} from "../src/gov/federation-usage.ts";
import { startServer } from "../src/server.ts";

const ROOT = "buckle-test-root";

/** Hub with scratch pool files; `selfReportTeams` seeds the per-team
 *  opt-in block (default OFF when empty). */
async function startFed(selfReportTeams: string[] = []): Promise<{
	base: string;
	stop: () => void;
}> {
	const dir = `/tmp/w171-fed-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
	const policy = [
		"version: 1",
		"gateway:",
		"  num_retries: 1",
		"  fallbacks:",
		"    glm-5.3-flash: [local-swarm, gpt-5.2]",
		...(selfReportTeams.length > 0
			? [
					"  federation:",
					"    self_report:",
					`      teams: [${selfReportTeams.join(", ")}]`,
				]
			: []),
		"tags:",
		"  glm-5.3-flash: [fast, cheap, general]",
		"",
	].join("\n");
	const upstreams = [
		"version: 1",
		"groups:",
		"  glm-5.3-flash:",
		"    - url: http://127.0.0.1:8501",
		"      dialect: openai",
		"  local-swarm:",
		"    - url: http://127.0.0.1:8502",
		"      dialect: openai",
		"      visibility: spoke-private",
		"  gpt-5.2: []",
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
		base: `http://127.0.0.1:${String(srv.port)}`,
		stop: () => srv.stop(true),
	};
}

async function issueKey(
	base: string,
	body: Record<string, unknown>,
): Promise<string> {
	const res = await fetch(`${base}/v1/admin/keys`, {
		method: "POST",
		headers: { authorization: `Bearer ${ROOT}` },
		body: JSON.stringify(body),
	});
	const out = (await res.json()) as { key: string };
	return out.key;
}

/** One valid self-report body; fields optional for negative tests. */
function reportBody(opts?: {
	team?: string;
	bucket?: number;
	extraTopKey?: boolean;
}): Record<string, unknown> {
	const body: Record<string, unknown> = {
		team: opts?.team ?? "platform",
		windows: [
			{
				bucket: opts?.bucket ?? Math.floor(Date.now() / 3_600_000) * 3_600_000,
				classes: {
					flash: {
						in_tok: 100,
						out_tok: 40,
						cache_r: 10,
						cache_c: 5,
						requests: 3,
					},
				},
				aids: [
					{
						aid: "lesson-recall",
						domain: "knowledge",
						injected: 2,
						skipped: 1,
						tok_injected: 900,
					},
				],
			},
		],
	};
	if (opts?.extraTopKey) body.actor_name = "jane doe";
	return body;
}

const hourAgo = (): number =>
	Math.floor(Date.now() / 3_600_000) * 3_600_000 - 3_600_000;

/** reportBody with the classes block swapped (negative tests). */
function winWith(classes: unknown): Record<string, unknown> {
	const body = reportBody();
	(
		(body.windows as Array<Record<string, unknown>>)[0] as Record<
			string,
			unknown
		>
	).classes = classes;
	return body;
}

describe("federation phase 3: default OFF is structural", () => {
	test("no policy block → manifest carries NO self_report rule; ingest → 403", async () => {
		const fed = await startFed();
		try {
			const man = (await (
				await fetch(`${fed.base}/federation/policy-manifest`, {
					headers: { authorization: `Bearer ${ROOT}` },
				})
			).json()) as { rules: Array<{ id: string }> };
			expect(man.rules.some((r) => r.id === "federation.self_report")).toBe(
				false,
			);
			const spoke = await issueKey(fed.base, {
				name: "spoke-x",
				scopes: ["buckle:spoke:READ_", "buckle:spoke:WRITE_"],
			});
			const res = await fetch(`${fed.base}/federation/usage`, {
				method: "POST",
				headers: {
					authorization: `Bearer ${spoke}`,
					"content-type": "application/json",
				},
				body: JSON.stringify(reportBody()),
			});
			expect(res.status).toBe(403);
			const out = (await res.json()) as { code: string };
			expect(out.code).toBe("buckle.self_report_disabled");
		} finally {
			fed.stop();
		}
	});
});

describe("federation phase 3: opt-in + ingest + read", () => {
	test("opted-in team: rule rides manifest, ingest stores, admin GET reads; spoke GET 403", async () => {
		const fed = await startFed(["platform"]);
		try {
			const spoke = await issueKey(fed.base, {
				name: "spoke-a",
				scopes: ["buckle:spoke:READ_", "buckle:spoke:WRITE_"],
			});
			const res = await fetch(`${fed.base}/federation/usage`, {
				method: "POST",
				headers: {
					authorization: `Bearer ${spoke}`,
					"content-type": "application/json",
				},
				body: JSON.stringify(reportBody()),
			});
			expect(res.status).toBe(200);
			const posted = (await res.json()) as { ok: boolean; rows: number };
			expect(posted.ok).toBe(true);
			expect(posted.rows).toBe(2);
			const got = await fetch(`${fed.base}/federation/usage?days=7`, {
				headers: { authorization: `Bearer ${ROOT}` },
			});
			expect(got.status).toBe(200);
			const rep = (await got.json()) as {
				spokes: number;
				windows: Array<{
					team: string;
					classes: Record<string, { in_tok: number }>;
				}>;
				aids: Array<{ aid: string; tok_injected: number }>;
			};
			expect(rep.spokes).toBe(1);
			expect(rep.windows[0]?.classes.flash?.in_tok).toBe(100);
			expect(rep.aids[0]?.aid).toBe("lesson-recall");
			const spokeGet = await fetch(`${fed.base}/federation/usage`, {
				headers: { authorization: `Bearer ${spoke}` },
			});
			expect(spokeGet.status).toBe(403);
		} finally {
			fed.stop();
		}
	});

	test("re-POST of the same window replaces (never double-counts)", async () => {
		const fed = await startFed(["platform"]);
		try {
			const spoke = await issueKey(fed.base, {
				name: "spoke-a",
				scopes: ["buckle:spoke:READ_", "buckle:spoke:WRITE_"],
			});
			const headers = {
				authorization: `Bearer ${spoke}`,
				"content-type": "application/json",
			};
			const body = JSON.stringify(reportBody({ bucket: hourAgo() }));
			for (let i = 0; i < 2; i++) {
				const r = await fetch(`${fed.base}/federation/usage`, {
					method: "POST",
					headers,
					body,
				});
				expect(r.status).toBe(200);
			}
			const got = await fetch(`${fed.base}/federation/usage?days=7`, {
				headers: { authorization: `Bearer ${ROOT}` },
			});
			const rep = (await got.json()) as {
				windows: Array<{ classes: Record<string, { in_tok: number }> }>;
			};
			expect(rep.windows).toHaveLength(1);
			expect(rep.windows[0]?.classes.flash?.in_tok).toBe(100);
		} finally {
			fed.stop();
		}
	});

	test("team not opted in → 403 even with the block listing another team", async () => {
		const fed = await startFed(["other-team"]);
		try {
			const spoke = await issueKey(fed.base, {
				name: "spoke-b",
				scopes: ["buckle:spoke:WRITE_", "buckle:spoke:READ_"],
			});
			const res = await fetch(`${fed.base}/federation/usage`, {
				method: "POST",
				headers: {
					authorization: `Bearer ${spoke}`,
					"content-type": "application/json",
				},
				body: JSON.stringify(reportBody({ team: "platform" })),
			});
			expect(res.status).toBe(403);
		} finally {
			fed.stop();
		}
	});
});

describe("federation phase 3: validation rejects bad bodies", () => {
	test("unknown top-level key, unknown class, negative count → 400", async () => {
		const fed = await startFed(["platform"]);
		try {
			const spoke = await issueKey(fed.base, {
				name: "spoke-c",
				scopes: ["buckle:spoke:WRITE_", "buckle:spoke:READ_"],
			});
			const post = (body: unknown): Promise<Response> =>
				fetch(`${fed.base}/federation/usage`, {
					method: "POST",
					headers: {
						authorization: `Bearer ${spoke}`,
						"content-type": "application/json",
					},
					body: JSON.stringify(body),
				});
			expect((await post(reportBody({ extraTopKey: true }))).status).toBe(400);
			const badClass = {
				"gpt-9": { in_tok: 1, out_tok: 1, cache_r: 0, cache_c: 0, requests: 1 },
			};
			expect((await post(winWith(badClass))).status).toBe(400);
			const neg = {
				flash: { in_tok: -1, out_tok: 0, cache_r: 0, cache_c: 0, requests: 1 },
			};
			expect((await post(winWith(neg))).status).toBe(400);
		} finally {
			fed.stop();
		}
	});
});

describe("federation phase 3: domain guard + caps + class contract", () => {
	test("data_domain=private anywhere in the body → 422, nothing stored", async () => {
		const fed = await startFed(["platform"]);
		try {
			const spoke = await issueKey(fed.base, {
				name: "spoke-d",
				scopes: ["buckle:spoke:WRITE_", "buckle:spoke:READ_"],
			});
			const body = winWith({});
			(
				(body.windows as Array<Record<string, unknown>>)[0] as Record<
					string,
					unknown
				>
			).data_domain = "private";
			const res = await fetch(`${fed.base}/federation/usage`, {
				method: "POST",
				headers: {
					authorization: `Bearer ${spoke}`,
					"content-type": "application/json",
				},
				body: JSON.stringify(body),
			});
			expect(res.status).toBe(422);
			const got = await fetch(`${fed.base}/federation/usage?days=7`, {
				headers: { authorization: `Bearer ${ROOT}` },
			});
			const rep = (await got.json()) as { windows: unknown[] };
			expect(rep.windows).toHaveLength(0);
		} finally {
			fed.stop();
		}
	});

	test("MODEL_CLASSES mirrors the suspenders GROUPS contract", () => {
		expect([...MODEL_CLASSES]).toEqual(GROUPS);
	});

	test("validateSelfReport: >168 windows and empty windows reject; one plain window passes", () => {
		const many = Array.from({ length: 169 }, (_, i) => ({
			bucket: i,
			classes: {},
			aids: [],
		}));
		expect(validateSelfReport({ team: "platform", windows: many }).ok).toBe(
			false,
		);
		expect(validateSelfReport({ team: "platform", windows: [] }).ok).toBe(
			false,
		);
		expect(
			validateSelfReport({
				team: "platform",
				windows: [{ bucket: 1, classes: {}, aids: [] }],
			}).ok,
		).toBe(true);
	});
});
