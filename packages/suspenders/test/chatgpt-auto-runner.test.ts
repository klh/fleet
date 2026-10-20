import { afterAll, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import {
	chmodSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const temp = mkdtempSync(join(tmpdir(), "chatgpt-auto-"));
const bin = join(temp, "bin");
mkdirSync(bin);
const repo = resolve(import.meta.dir, "../../..");
const notify = join(temp, "notify.yaml");
const clip = join(temp, "clipboard.txt");
writeFileSync(notify, "chatgpt:\n  auto: true\n");
writeFileSync(
	join(bin, "pbcopy"),
	"#!/usr/bin/env bun\nawait Bun.write(process.env.AUTO_CLIP_FILE!, await Bun.stdin.text());\n",
);
writeFileSync(join(bin, "osascript"), "#!/usr/bin/env bun\nprocess.exit(0);\n");
chmodSync(join(bin, "pbcopy"), 0o755);
chmodSync(join(bin, "osascript"), 0o755);
afterAll(() => rmSync(temp, { recursive: true, force: true }));

const env = {
	...process.env,
	HOME: temp,
	KLH_NOTIFY: notify,
	AUTO_CLIP_FILE: clip,
	PATH: `${bin}:${process.env.PATH ?? ""}`,
	SUSPENDERS_KEV_URL: "http://127.0.0.1:1",
};
const runner = join(import.meta.dir, "../hooks/bin/chatgpt-auto.ts");
function run(file: string, args: string[] = []) {
	return Bun.spawnSync([process.execPath, file, ...args], {
		cwd: repo,
		env,
		stdout: "pipe",
		stderr: "pipe",
		timeout: 20_000,
	});
}

test("runner queues, dedupes, delivers and records feedback", () => {
	expect(run(runner, ["--repo", repo]).exitCode).toBe(0);
	const db = new Database(join(temp, ".cache/claude-governor/governor.db"));
	const project = (
		db.query("SELECT project FROM chatgpt_auto_meta").get() as {
			project: string;
		}
	).project;
	const stamp = Date.now();
	db.query(
		"INSERT INTO work_items(project,id,title,state,created_at,updated_at) VALUES (?, 'W7', 'Review rollout', 'FAILED', ?, ?)",
	).run(project, stamp, stamp);
	db.query(
		"INSERT INTO events(ts,source,kind,scope,payload,target) VALUES (?, 'lane-7', 'NEED_DECISION', 'W7', ?, NULL)",
	).run(
		stamp,
		JSON.stringify({ project, item: "W7", note: "Choose rollout plan" }),
	);
	expect(run(runner, ["--repo", repo]).exitCode).toBe(0);
	expect(readFileSync(clip, "utf8")).toContain("Choose rollout plan");
	const consult = db
		.query("SELECT id,state FROM consults WHERE project = ?")
		.get(project) as { id: number; state: string };
	expect(consult.state).toBe("OPEN");
	expect(readFileSync(clip, "utf8")).toContain(`Consult: C${consult.id}`);
	const feedbackRun = run(runner, ["--repo", repo]);
	expect(feedbackRun.stderr.toString()).toBe("");
	expect(feedbackRun.exitCode).toBe(0);
	expect(
		(db.query("SELECT COUNT(*) AS n FROM consults").get() as { n: number }).n,
	).toBe(1);
	const reply = run(join(import.meta.dir, "../hooks/bin/coord.ts"), [
		"consult-reply",
		`C${consult.id}`,
		"Reviewed.\nVERDICT: PASS",
		"--as",
		"chatgpt-auto",
	]);
	expect(reply.exitCode).toBe(0);
	const afterReply = run(runner, ["--repo", repo]);
	expect(afterReply.stderr.toString()).toBe("");
	expect(afterReply.exitCode).toBe(0);
	expect(
		(
			db.query("SELECT status FROM chatgpt_auto_runs").get() as {
				status: string;
			}
		).status,
	).toBe("FEEDBACK");
	expect(
		(
			db.query("SELECT outcome FROM consult_feedback").get() as {
				outcome: string;
			}
		).outcome,
	).toBe("unused");
	db.close();
});
