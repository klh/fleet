import { afterAll, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import {
	chmodSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	checkSessionPolicies,
	boundedPolicyEvaluation,
	evaluateSessionPolicy,
	policyAuthority,
} from "../hooks/lib/session-policy.ts";
import {
	proposeRemediation,
	decideRemediation,
	getRemediationById,
} from "../hooks/lib/policy-workflow/store.ts";
import { HEALTH_POLICY_ID } from "../hooks/lib/policy-workflow/health-policy.ts";
import { boardFixture } from "./helpers/board-fixture.ts";

const fixture = await boardFixture(0, afterAll);
const home = mkdtempSync(join(tmpdir(), "session-policy-"));
afterAll(() => rmSync(home, { recursive: true, force: true }));
const rows = [
	{
		id: "service-health",
		repoClass: "api",
		detect: [{ exists: "server.ts" }],
		check: [{ grep: "server.ts", pattern: "/health|/status" }],
		missingQuestion: "This service lacks a health endpoint. Implement one?",
		policySource: "operator:service-health-v1",
		serviceId: "orders-api",
		policyId: "corp.api.independent-health",
		orgId: "org1",
	},
];
writeFileSync(
	join(fixture.REPO, "server.ts"),
	"Bun.serve({fetch:()=>new Response('api')})",
);
const sha256 = createHash("sha256").update(JSON.stringify(rows)).digest("hex");
const server = Bun.serve({
	hostname: "127.0.0.1",
	port: 0,
	fetch(request) {
		if (request.headers.get("authorization") !== "Bearer fixture-private-key")
			return new Response("denied", { status: 401 });
		return Response.json({ ok: true, version: 1, sha256, rows });
	},
});
afterAll(() => server.stop(true));
const keyFile = join(home, "key");
writeFileSync(keyFile, "fixture-private-key", { mode: 0o600 });
const configPath = join(home, "policy.json");
writeFileSync(
	configPath,
	JSON.stringify({
		version: 1,
		hubs: [{ url: server.url.origin, keyFile, sha256 }],
	}),
);
const db = new Database(`${fixture.HOME}/.cache/claude-governor/governor.db`);
afterAll(() => db.close());
const options = {
	db,
	repo: fixture.REPO,
	project: fixture.REPO,
	configPath,
	sid: "policy-session",
};

test("mother, siblings and grandchild share one decision while new mothers still ask", async () => {
	const insert = db.query(
		"INSERT INTO sessions (sid,project,parent_sid,state,started_at,hb) VALUES (?,?,?,'RUNNING',?,?)",
	);
	for (const [sid, parent] of [
		["family-mother", null],
		["family-child-a", "family-mother"],
		["family-child-b", "family-mother"],
		["family-grandchild", "family-child-a"],
		["independent-mother", null],
	])
		insert.run(sid, options.project, parent, Date.now(), Date.now());
	const mother = await checkSessionPolicies({
		...options,
		sid: "family-mother",
	});
	const id = mother[0].match(/POLICY DECISION (\d+)/)?.[1];
	expect(id).toBeDefined();
	for (const sid of ["family-child-a", "family-child-b", "family-grandchild"])
		expect((await checkSessionPolicies({ ...options, sid }))[0]).toContain(
			`POLICY REFERENCE ${id}`,
		);
	expect(
		db
			.query(
				"SELECT COUNT(*) AS n FROM events WHERE target='family-mother' AND kind='NEED_DECISION'",
			)
			.get(),
	).toEqual({ n: 1 });
	const response = await fetch(
		`${fixture.BASE}/api/decisions?project=${encodeURIComponent(options.project)}`,
	);
	expect(
		(await response.json()).decisions.some(
			(row: { id: number }) => String(row.id) === id,
		),
	).toBe(true);
	expect(
		(await checkSessionPolicies({ ...options, sid: "independent-mother" }))[0],
	).toContain("POLICY DECISION");
});

test("policy ancestry rejects cross-project, stale and cyclic parents", () => {
	const insert = db.query(
		"INSERT INTO sessions (sid,project,parent_sid,state,started_at,hb) VALUES (?,?,?,'RUNNING',?,?)",
	);
	insert.run("foreign-parent", "foreign-project", null, Date.now(), Date.now());
	insert.run(
		"foreign-child",
		options.project,
		"foreign-parent",
		Date.now(),
		Date.now(),
	);
	expect(() => policyAuthority(db, "foreign-child", options.project)).toThrow(
		"this project",
	);
	insert.run("stale-parent", options.project, null, 0, 0);
	insert.run(
		"stale-child",
		options.project,
		"stale-parent",
		Date.now(),
		Date.now(),
	);
	expect(() => policyAuthority(db, "stale-child", options.project)).toThrow(
		"live registered",
	);
	db.query("UPDATE sessions SET hb=? WHERE sid='stale-parent'").run(
		Date.now() + 60_000,
	);
	expect(() => policyAuthority(db, "stale-child", options.project)).toThrow(
		"live registered",
	);
	insert.run("cycle-a", options.project, "cycle-b", Date.now(), Date.now());
	insert.run("cycle-b", options.project, "cycle-a", Date.now(), Date.now());
	expect(() => policyAuthority(db, "cycle-a", options.project)).toThrow(
		"cycle",
	);
});

test("corrupt or missing dedupe event references cannot suppress policy assessment", async () => {
	const sid = "corrupt-policy-reference";
	const first = await checkSessionPolicies({ ...options, sid });
	const id = Number(first[0].match(/POLICY DECISION (\d+)/)?.[1]);
	expect(Number.isSafeInteger(id)).toBe(true);
	const fact = db
		.query("SELECT key FROM facts WHERE value=?")
		.get(String(id)) as { key: string };
	for (const value of ["not-an-event", "999999999"]) {
		db.query("UPDATE facts SET value=? WHERE key=?").run(value, fact.key);
		expect((await checkSessionPolicies({ ...options, sid }))[0]).toContain(
			"POLICY CHECK UNAVAILABLE",
		);
	}
	db.query("UPDATE facts SET value=? WHERE key=?").run(String(id), fact.key);
	db.query("UPDATE events SET target='different-parent' WHERE id=?").run(id);
	expect((await checkSessionPolicies({ ...options, sid }))[0]).toContain(
		"provenance mismatch",
	);
	expect(
		db
			.query(
				"SELECT COUNT(*) AS n FROM events WHERE source=? AND kind='NEED_DECISION'",
			)
			.get(sid),
	).toEqual({ n: 1 });
});

test("remote authenticated policy persists provenance and a real board decision once per session", async () => {
	const notes = await checkSessionPolicies(options);
	expect(notes).toHaveLength(1);
	expect(notes[0]).toContain("Ask for approval");
	expect(await checkSessionPolicies(options)).toEqual([]);
	const events = db
		.query(
			"SELECT payload,target FROM events WHERE source = ? AND kind = 'NEED_DECISION'",
		)
		.all(options.sid) as { payload: string; target: string }[];
	expect(events).toHaveLength(1);
	expect(JSON.parse(events[0].payload).policy).toEqual({
		hub: server.url.origin,
		sha256,
		id: "service-health",
		source: "operator:service-health-v1",
	});
	expect(events[0].target).toBe(options.sid);
	const response = await fetch(
		`${fixture.BASE}/api/decisions?project=${encodeURIComponent(fixture.REPO)}`,
	);
	const data = await response.json();
	expect(
		data.decisions.some(
			(row) =>
				row.question.startsWith(rows[0].missingQuestion) &&
				row.question.includes(sha256),
		),
	).toBe(true);
	await checkSessionPolicies({ ...options, sid: "next-session" });
	expect(
		db
			.query(
				"SELECT COUNT(*) AS n FROM events WHERE source IN ('policy-session','next-session') AND kind = 'NEED_DECISION'",
			)
			.get(),
	).toEqual({ n: 2 });
});

test("actual SessionStart automatically checks configured remote policy", async () => {
	const configDir = join(fixture.HOME, ".config/klh");
	mkdirSync(configDir, { recursive: true });
	writeFileSync(join(configDir, "repo-policy.json"), readFileSync(configPath));
	const payload = join(home, "startup.json");
	writeFileSync(
		payload,
		JSON.stringify({
			session_id: "actual-policy-start",
			cwd: fixture.REPO,
			source: "startup",
		}),
	);
	const proc = Bun.spawn(
		["bun", join(import.meta.dir, "../hooks/session-start.ts")],
		{
			cwd: fixture.REPO,
			env: fixture.env,
			stdin: Bun.file(payload),
			stdout: "pipe",
			stderr: "pipe",
		},
	);
	const output = await new Response(proc.stdout).text();
	expect(await proc.exited).toBe(0);
	expect(output).toContain("POLICY DECISION");
	expect(output).toContain(sha256);
	expect(output).toContain(server.url.origin);
	expect(
		db
			.query(
				"SELECT COUNT(*) AS n FROM events WHERE source = 'actual-policy-start' AND kind = 'NEED_DECISION'",
			)
			.get(),
	).toEqual({ n: 1 });
});

test("satisfied policies stay silent and do not create decisions", async () => {
	writeFileSync(join(fixture.REPO, "server.ts"), "GET /health");
	expect(
		await checkSessionPolicies({ ...options, sid: "satisfied-session" }),
	).toEqual([]);
	writeFileSync(join(fixture.REPO, "server.ts"), "api");
});

test("SessionStart uses a trusted absolute runtime configuration override", async () => {
	const sid = "scoped-policy-start";
	const defaultPath = join(fixture.HOME, ".config/klh/repo-policy.json");
	const defaultBytes = readFileSync(defaultPath);
	writeFileSync(defaultPath, "invalid default configuration");
	const proc = Bun.spawn(
		["bun", join(import.meta.dir, "../hooks/session-start.ts")],
		{
			cwd: fixture.REPO,
			env: { ...fixture.env, SUSPENDERS_REPO_POLICY_CONFIG: configPath },
			stdin: "pipe",
			stdout: "pipe",
			stderr: "pipe",
		},
	);
	proc.stdin.write(JSON.stringify({ session_id: sid, cwd: fixture.REPO }));
	proc.stdin.end();
	const output = await new Response(proc.stdout).text();
	const code = await proc.exited;
	writeFileSync(defaultPath, defaultBytes);
	expect(code).toBe(0);
	expect(output).toContain("POLICY DECISION");
	expect(output).toContain(sha256);
	expect(
		db
			.query(
				"SELECT COUNT(*) AS n FROM events WHERE source = ? AND kind = 'NEED_DECISION'",
			)
			.get(sid),
	).toEqual({ n: 1 });
});

test("SessionStart refuses relative configuration overrides without creating decisions", async () => {
	const sid = "unsafe-policy-start";
	const proc = Bun.spawn(
		["bun", join(import.meta.dir, "../hooks/session-start.ts")],
		{
			cwd: fixture.REPO,
			env: {
				...fixture.env,
				SUSPENDERS_REPO_POLICY_CONFIG: "repo-policy.json",
			},
			stdin: "pipe",
			stdout: "pipe",
			stderr: "pipe",
		},
	);
	proc.stdin.write(JSON.stringify({ session_id: sid, cwd: fixture.REPO }));
	proc.stdin.end();
	const output = await new Response(proc.stdout).text();
	expect(await proc.exited).toBe(0);
	expect(output).toContain("POLICY CHECK UNAVAILABLE");
	expect(
		db
			.query(
				"SELECT COUNT(*) AS n FROM events WHERE source = ? AND kind = 'NEED_DECISION'",
			)
			.get(sid),
	).toEqual({ n: 0 });
});

test("pin mismatch and public credentials produce unavailable, never compliant", async () => {
	const mismatch = join(home, "mismatch.json");
	writeFileSync(
		mismatch,
		JSON.stringify({
			version: 1,
			hubs: [{ url: server.url.origin, keyFile, sha256: "0".repeat(64) }],
		}),
	);
	expect(
		(await checkSessionPolicies({ ...options, configPath: mismatch }))[0],
	).toContain("pin mismatch");
	chmodSync(keyFile, 0o644);
	expect((await checkSessionPolicies(options))[0]).toContain(
		"private bounded file",
	);
	chmodSync(keyFile, 0o600);
});

test("unreachable hub surfaces unknown compliance without a decision", async () => {
	const down = join(home, "down.json");
	writeFileSync(
		down,
		JSON.stringify({
			version: 1,
			hubs: [{ url: "http://127.0.0.1:9", keyFile, sha256 }],
		}),
	);
	const sid = "hub-down-session";
	const notes = await checkSessionPolicies({
		...options,
		configPath: down,
		sid,
	});
	expect(notes).toHaveLength(1);
	expect(notes[0]).toContain("POLICY CHECK UNAVAILABLE");
	expect(notes[0]).toContain("http://127.0.0.1:9");
	expect(notes[0]).toContain("policy compliance is unknown");
	expect(
		db
			.query(
				"SELECT COUNT(*) AS n FROM events WHERE source = ? AND kind = 'NEED_DECISION'",
			)
			.get(sid),
	).toEqual({ n: 0 });
});

test("unsafe paths, symlinks and remote probe instructions are refused", () => {
	for (const check of [
		[{ exists: "../outside" }],
		[{ exists: "/etc/passwd" }],
		[{ httpGet: "https://elsewhere" }],
	])
		expect(() =>
			evaluateSessionPolicy(fixture.REPO, [{ ...rows[0], check }]),
		).toThrow();
	symlinkSync(home, join(fixture.REPO, "outside"));
	expect(() =>
		evaluateSessionPolicy(fixture.REPO, [
			{ ...rows[0], check: [{ exists: "outside/key" }] },
		]),
	).toThrow("symlink leaves repo");
});

test("oversized files and pathological regex cannot claim a missing endpoint", async () => {
	writeFileSync(join(fixture.REPO, "oversize.ts"), "x".repeat(1024 * 1024 + 1));
	await expect(
		boundedPolicyEvaluation(fixture.REPO, [
			{
				...rows[0],
				detect: [],
				check: [{ grep: "oversize.ts", pattern: "/health" }],
			},
		]),
	).rejects.toThrow("read limit");
	writeFileSync(join(fixture.REPO, "pathological.ts"), `${"a".repeat(200)}!`);
	await expect(
		boundedPolicyEvaluation(
			fixture.REPO,
			[
				{
					...rows[0],
					detect: [],
					check: [{ grep: "pathological.ts", pattern: "^(a+)+$" }],
				},
			],
			1,
		),
	).rejects.toThrow("timed out");
});

test("an approved scoped exception suppresses the per-session decision until it expires", async () => {
	// baseline: a fresh session still gets its own decision event
	await checkSessionPolicies({ ...options, sid: "exc-baseline" });
	const n = (sid: string): { n: number } =>
		db
			.query(
				"SELECT COUNT(*) AS n FROM events WHERE source = ? AND kind = 'NEED_DECISION'",
			)
			.get(sid) as { n: number };
	expect(n("exc-baseline")).toEqual({ n: 1 });
	// the org grants a scoped exception through the policy workflow (the
	// same governor.db the session check reads)
	const created = proposeRemediation(db, {
		project: fixture.REPO,
		orgId: "org1",
		serviceId: "orders-api",
		policyId: HEALTH_POLICY_ID,
		proposal: { observedGap: "health endpoints missing" },
	});
	const hash =
		getRemediationById(db, fixture.REPO, created.id)?.proposalHash ?? "";
	decideRemediation(db, {
		project: fixture.REPO,
		remediationId: created.id,
		action: "exception",
		actor: "corp",
		proposalHash: hash,
		exceptionExpiresAt: Date.now() + 60_000,
	});
	// a fresh session while the waiver is live: suppressed with an honest
	// note — no new decision event
	const notes = await checkSessionPolicies({ ...options, sid: "exc-live" });
	expect(notes).toHaveLength(1);
	expect(notes[0]).toContain("POLICY EXCEPTION active");
	expect(n("exc-live")).toEqual({ n: 0 });
	// the waiver expires → the reminder loop resumes for the next session
	db.query("UPDATE policy_decisions SET expires_at = ?").run(Date.now() - 1);
	await checkSessionPolicies({ ...options, sid: "exc-resumed" });
	expect(n("exc-resumed")).toEqual({ n: 1 });
});
