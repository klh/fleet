import { afterAll, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { realpathSync } from "node:fs";
import { join } from "node:path";
import { boardFixture } from "./helpers/board-fixture.ts";

const fixture = await boardFixture(0, afterAll);
const db = new Database(`${fixture.HOME}/.cache/claude-governor/governor.db`);
afterAll(() => db.close());
const project = realpathSync(fixture.REPO);
function seed(sid: string, scope = project) {
	db.query(
		"INSERT INTO sessions(sid,project,state,started_at,hb) VALUES (?,?,'RUNNING',?,?)",
	).run(sid, scope, Date.now(), Date.now());
}
async function bootstrap(...args: string[]) {
	return bootstrapAt(fixture.REPO, ...args);
}
async function bootstrapAt(cwd: string, ...args: string[]) {
	const child = Bun.spawn(
		[
			"bun",
			join(import.meta.dir, "../hooks/bin/coord.ts"),
			"bootstrap",
			...args,
		],
		{ cwd, env: fixture.env, stdout: "pipe", stderr: "pipe" },
	);
	await new Response(child.stdout).text();
	await new Response(child.stderr).text();
	return await child.exited;
}
test("supported bootstrap binds metadata on an existing row and preserves it on resume", async () => {
	seed("metadata-mother");
	seed("metadata-existing");
	expect(
		await bootstrap(
			"--as",
			"metadata-existing",
			"--parent",
			"metadata-mother",
			"--worktree",
			fixture.REPO,
		),
	).toBe(0);
	expect(
		db
			.query(
				"SELECT parent_sid,worktree FROM sessions WHERE sid='metadata-existing'",
			)
			.get(),
	).toEqual({ parent_sid: "metadata-mother", worktree: project });
	expect(
		await bootstrap("--as", "metadata-existing", "--name", "resumed lane"),
	).toBe(0);
	expect(
		db
			.query(
				"SELECT parent_sid,worktree FROM sessions WHERE sid='metadata-existing'",
			)
			.get(),
	).toEqual({ parent_sid: "metadata-mother", worktree: project });
});
test("competing parent bindings produce one winner and one refusal", async () => {
	seed("race-mother-a");
	seed("race-mother-b");
	const codes = await Promise.all([
		bootstrap(
			"--as",
			"race-child",
			"--parent",
			"race-mother-a",
			"--worktree",
			fixture.REPO,
		),
		bootstrap(
			"--as",
			"race-child",
			"--parent",
			"race-mother-b",
			"--worktree",
			fixture.REPO,
		),
	]);
	expect(codes.filter((code) => code === 0)).toHaveLength(1);
	expect(codes.filter((code) => code !== 0)).toHaveLength(1);
	const row = db
		.query("SELECT parent_sid,project FROM sessions WHERE sid='race-child'")
		.get() as { parent_sid: string; project: string };
	expect(row.project).toBe(project);
	expect(row.parent_sid).toBe(
		codes[0] === 0 ? "race-mother-a" : "race-mother-b",
	);
});
test("competing project registrations cannot silently replace the winning identity", async () => {
	const codes = await Promise.all([
		bootstrap("--as", "race-project-child"),
		bootstrapAt(fixture.GREPO, "--as", "race-project-child"),
	]);
	expect(codes.filter((code) => code === 0)).toHaveLength(1);
	expect(codes.filter((code) => code !== 0)).toHaveLength(1);
	const row = db
		.query("SELECT project FROM sessions WHERE sid='race-project-child'")
		.get() as { project: string };
	expect(row.project).toBe(
		codes[0] === 0 ? project : realpathSync(fixture.GREPO),
	);
});
test("bootstrap refuses foreign or reassigned parent metadata", async () => {
	seed("metadata-foreign", "foreign-project");
	seed("metadata-other-mother");
	expect(
		await bootstrap(
			"--as",
			"metadata-existing",
			"--parent",
			"metadata-foreign",
		),
	).not.toBe(0);
	expect(
		await bootstrap(
			"--as",
			"metadata-existing",
			"--parent",
			"metadata-other-mother",
		),
	).not.toBe(0);
	expect(
		db
			.query("SELECT parent_sid FROM sessions WHERE sid='metadata-existing'")
			.get(),
	).toEqual({ parent_sid: "metadata-mother" });
});
