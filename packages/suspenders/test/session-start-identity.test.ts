import { afterAll, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { boardFixture } from "./helpers/board-fixture.ts";

const fixture = await boardFixture(0, afterAll);
const db = new Database(`${fixture.HOME}/.cache/claude-governor/governor.db`);
afterAll(() => db.close());
const project = realpathSync(fixture.REPO);

function register(sid: string, parent: string | null = null, scope = project) {
	db.query(
		"INSERT INTO sessions (sid,project,parent_sid,worktree,started_at,hb,state) VALUES (?,?,?,?,?,?,'RUNNING')",
	).run(sid, scope, parent, realpathSync(fixture.REPO), Date.now(), Date.now());
}
function claim(sid: string, id: string) {
	db.query(
		"INSERT INTO work_items (project,id,title,state,owner_sid,created_at,updated_at) VALUES (?,?,?,'CLAIMED',?,?,?)",
	).run(project, id, id, sid, Date.now(), Date.now());
}
async function start(
	sdk: string,
	canonical?: string,
	configPath?: string,
	protocol: string | null = "canonical-v1",
) {
	const env = { ...fixture.env };
	delete env.SUSPENDERS_SID;
	delete env.SUSPENDERS_REPO_POLICY_CONFIG;
	delete env.SUSPENDERS_SESSION_IDENTITY_PROTOCOL;
	if (canonical !== undefined) env.SUSPENDERS_SID = canonical;
	if (canonical !== undefined && protocol !== null)
		env.SUSPENDERS_SESSION_IDENTITY_PROTOCOL = protocol;
	if (configPath !== undefined) env.SUSPENDERS_REPO_POLICY_CONFIG = configPath;
	const proc = Bun.spawn(
		["bun", join(import.meta.dir, "../hooks/session-start.ts")],
		{ cwd: fixture.REPO, env, stdin: "pipe", stdout: "pipe", stderr: "pipe" },
	);
	proc.stdin.write(JSON.stringify({ session_id: sdk, cwd: fixture.REPO }));
	proc.stdin.end();
	return {
		output: await new Response(proc.stdout).text(),
		code: await proc.exited,
	};
}
test("unversioned legacy callers retain SDK identity without a registered canonical row", async () => {
	const result = await start(
		"unversioned-sdk",
		"unregistered-legacy",
		undefined,
		null,
	);
	expect(result.code).toBe(0);
	expect(
		db
			.query("SELECT parent_sid FROM sessions WHERE sid=?")
			.get("unversioned-sdk"),
	).toEqual({ parent_sid: null });
	expect(
		db.query("SELECT sid FROM sessions WHERE sid=?").get("unregistered-legacy"),
	).toBeNull();
});
test("unknown identity protocols refuse startup", async () => {
	const result = await start(
		"unknown-protocol-sdk",
		"unregistered",
		undefined,
		"canonical-v2",
	);
	expect(result.code).toBe(1);
	expect(result.output).toContain("SESSION IDENTITY REFUSED");
	expect(
		db
			.query("SELECT sid FROM sessions WHERE sid=?")
			.get("unknown-protocol-sdk"),
	).toBeNull();
});
test("actual SessionStart registers the claimed canonical lane and preserves its mother", async () => {
	register("identity-mother");
	register("identity-lane", "identity-mother");
	claim("identity-lane", "IDENTITY1");
	const result = await start("sdk-generated-session", "identity-lane");
	expect(result.code).toBe(0);
	expect(result.output).toContain("identity-lane");
	expect(
		db
			.query("SELECT parent_sid FROM sessions WHERE sid=?")
			.get("identity-lane"),
	).toEqual({ parent_sid: "identity-mother" });
	expect(
		db
			.query("SELECT sid FROM sessions WHERE sid=?")
			.get("sdk-generated-session"),
	).toBeNull();
});
test("a declared lane without an active claim cannot register a harness alias", async () => {
	register("identity-unclaimed");
	const result = await start("sdk-unclaimed", "identity-unclaimed");
	expect(result.code).toBe(1);
	expect(result.output).toContain("SESSION IDENTITY REFUSED");
	expect(
		db.query("SELECT sid FROM sessions WHERE sid=?").get("sdk-unclaimed"),
	).toBeNull();
});
test("a cross-project declared lane is refused", async () => {
	register("identity-cross", null, "other-project");
	claim("identity-cross", "IDENTITY2");
	const result = await start("sdk-cross", "identity-cross");
	expect(result.code).toBe(1);
	expect(result.output).toContain("SESSION IDENTITY REFUSED");
	expect(
		db.query("SELECT sid FROM sessions WHERE sid=?").get("sdk-cross"),
	).toBeNull();
});
test("a declared lane cannot adopt another worktree", async () => {
	register("identity-wrong-tree");
	claim("identity-wrong-tree", "IDENTITY3");
	db.query("UPDATE sessions SET worktree=? WHERE sid=?").run(
		fixture.GREPO,
		"identity-wrong-tree",
	);
	const result = await start("sdk-wrong-tree", "identity-wrong-tree");
	expect(result.code).toBe(1);
	expect(result.output).toContain("SESSION IDENTITY REFUSED");
	expect(
		db.query("SELECT sid FROM sessions WHERE sid=?").get("sdk-wrong-tree"),
	).toBeNull();
});
test("an absent declared lane cannot manufacture registration", async () => {
	const result = await start("sdk-absent", "missing-lane");
	expect(result.code).toBe(1);
	expect(result.output).toContain("SESSION IDENTITY REFUSED");
	expect(
		db
			.query("SELECT sid FROM sessions WHERE sid IN (?,?)")
			.all("sdk-absent", "missing-lane"),
	).toEqual([]);
});
test("a standalone session retains its SDK identity", async () => {
	expect((await start("standalone-sdk")).code).toBe(0);
	expect(
		db
			.query("SELECT parent_sid FROM sessions WHERE sid=?")
			.get("standalone-sdk"),
	).toEqual({ parent_sid: null });
});
test("a registered legacy lane without worktree metadata retains its SDK identity", async () => {
	register("legacy-canonical");
	claim("legacy-canonical", "IDENTITY5");
	db.query("UPDATE sessions SET worktree=NULL WHERE sid=?").run(
		"legacy-canonical",
	);
	const result = await start("legacy-sdk", "legacy-canonical");
	expect(result.code).toBe(0);
	expect(
		db.query("SELECT parent_sid FROM sessions WHERE sid=?").get("legacy-sdk"),
	).toEqual({ parent_sid: null });
	expect(result.output).toContain("legacy-sdk");
});
test("the actual canonical lane startup and GUI reference one mother policy decision", async () => {
	register("policy-identity-mother");
	register("policy-identity-lane", "policy-identity-mother");
	claim("policy-identity-lane", "IDENTITY4");
	writeFileSync(join(fixture.REPO, "identity-api.ts"), "api");
	const rows = [
		{
			id: "identity-health",
			detect: [{ exists: "identity-api.ts" }],
			check: [{ grep: "identity-api.ts", pattern: "/health" }],
			missingQuestion: "Add health?",
			policySource: "test:identity",
		},
	];
	const sha256 = createHash("sha256")
		.update(JSON.stringify(rows))
		.digest("hex");
	const server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		fetch: () => Response.json({ ok: true, version: 1, sha256, rows }),
	});
	const keyFile = join(fixture.HOME, "identity-policy-key");
	writeFileSync(keyFile, "private-test-key", { mode: 0o600 });
	const configPath = join(fixture.HOME, "identity-policy.json");
	writeFileSync(
		configPath,
		JSON.stringify({
			version: 1,
			hubs: [{ url: server.url.origin, keyFile, sha256 }],
		}),
	);
	try {
		const result = await start(
			"sdk-policy-alias",
			"policy-identity-lane",
			configPath,
		);
		expect(result.code).toBe(0);
		const event = db
			.query(
				"SELECT id,source,target FROM events WHERE source=? AND kind='NEED_DECISION'",
			)
			.get("policy-identity-lane") as {
			id: number;
			source: string;
			target: string;
		};
		expect(event.target).toBe("policy-identity-mother");
		expect(result.output).toContain(`POLICY DECISION ${event.id}`);
		expect(
			db.query("SELECT sid FROM sessions WHERE sid=?").get("sdk-policy-alias"),
		).toBeNull();
		const response = await fetch(
			`${fixture.BASE}/api/decisions?project=${encodeURIComponent(project)}`,
		);
		const data = await response.json();
		expect(
			data.decisions.some(
				(row: { id: number; question: string }) =>
					row.id === event.id && row.question.includes(sha256),
			),
		).toBe(true);
	} finally {
		server.stop(true);
	}
});
