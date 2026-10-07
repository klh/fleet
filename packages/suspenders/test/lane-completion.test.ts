import { afterAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = mkdtempSync(join(tmpdir(), "fleet-completion-"));
const home = join(root, "home");
mkdirSync(home);
const env = { ...process.env, HOME: home };
const source = join(import.meta.dir, "../hooks");
afterAll(() => rmSync(root, { recursive: true, force: true }));
let sequence = 0;

function command(cwd: string, args: string[], input?: unknown) {
	const payload = join(root, "input.json");
	writeFileSync(payload, JSON.stringify(input ?? {}));
	const p = Bun.spawnSync(args, {
		cwd,
		env,
		stdin: Bun.file(payload),
		stdout: "pipe",
		stderr: "pipe",
	});
	return {
		code: p.exitCode,
		out: p.stdout.toString(),
		err: p.stderr.toString(),
	};
}
function fixture() {
	const cwd = join(root, `repo-${++sequence}`);
	mkdirSync(cwd);
	const git = (...args: string[]) => command(cwd, ["git", ...args]);
	git("init", "-q");
	git("config", "user.email", "test@example.invalid");
	git("config", "user.name", "test");
	writeFileSync(join(cwd, "README.md"), "base\n");
	git("add", "README.md");
	git("commit", "-qm", "base");
	const work = (...args: string[]) =>
		command(cwd, [process.execPath, join(source, "bin/work.ts"), ...args]);
	const id = work("add", "completion test").out.match(/W\d+/)?.[0] ?? "";
	expect(work("take", id, "--as", "dispatch-owner").code).toBe(0);
	mkdirSync(join(cwd, ".fleet"));
	writeFileSync(join(cwd, ".klh-brief.md"), "generated mission");
	writeFileSync(
		join(cwd, ".fleet/lane-context.json"),
		JSON.stringify({
			sid: "dispatch-owner",
			item: id,
			baseline: git("rev-parse", "HEAD").out.trim(),
			launchedAt: 123,
		}),
	);
	const stop = (message?: string) =>
		command(cwd, [process.execPath, join(source, "gate.ts"), "stop"], {
			cwd,
			session_id: "harness-uuid-different-from-owner",
			stop_hook_active: true,
			last_assistant_message: message,
		});
	return { cwd, git, work, id, stop };
}

test("empty lane cannot bypass stop checks; third stop records FAILED", () => {
	const f = fixture();
	for (let attempt = 1; attempt <= 2; attempt++) {
		const result = f.stop();
		expect(result.err + result.out).toContain(`Re-ask ${attempt}/2`);
	}
	expect(f.stop().code).toBe(0);
	expect(JSON.parse(f.work("show", f.id, "--json").out).state).toBe("FAILED");
});

test("real documentation edits and committed changes count; scaffold does not", () => {
	const f = fixture();
	writeFileSync(join(f.cwd, "README.md"), "meaningful change\n");
	expect(f.stop().code).toBe(0);
	f.git("add", "README.md");
	f.git("commit", "-qm", "delivered docs");
	expect(f.stop().code).toBe(0);
	expect(JSON.parse(f.work("show", f.id, "--json").out).state).toBe("CLAIMED");
});

test("explicit blocked reason records incomplete work, never success", () => {
	const f = fixture();
	expect(f.stop(`BLOCKED ${f.id}: upstream service is unavailable`).code).toBe(
		0,
	);
	expect(JSON.parse(f.work("show", f.id, "--json").out).state).toBe("FAILED");
});

test("a different graph owner is not controlled by this lane", () => {
	const f = fixture();
	f.work("release", f.id, "--as", "dispatch-owner");
	f.work("take", f.id, "--as", "other-owner");
	expect(f.stop().code).toBe(0);
	expect(JSON.parse(f.work("show", f.id, "--json").out).owner_sid).toBe(
		"other-owner",
	);
});
