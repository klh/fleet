#!/usr/bin/env bun
// Opt-in fleet-loop task: event-triggered ChatGPT desktop consults.
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import {
	canSend,
	composeBrief,
	eventPayload,
	safeTrigger,
	triggerOf,
	verdictFeedback,
	type AutoEvent,
	type AutoItem,
	type AutoTrigger,
} from "../lib/chatgpt-auto.ts";
import { consultDeadline } from "../lib/consult-expiry.ts";
import { openGovernorDb, projectIdentity } from "../lib/govdb.ts";
import { loadNotifyConfig } from "../lib/notify.ts";
import {
	defineVerb,
	dieFor,
	parseVerb,
	renderVerbHelp,
} from "../lib/verb-kit.ts";

const SPEC = defineVerb({
	name: "chatgpt-auto",
	usage: "usage: chatgpt-auto --repo <dir>",
	flags: ["--repo"],
});
const argv = process.argv.slice(2);
if (argv.includes("--help") || argv.includes("-h")) {
	console.log(renderVerbHelp(SPEC));
	process.exit(0);
}
const parsed = parseVerb(SPEC, argv);
if (!parsed.ok) dieFor("chatgpt-auto")(parsed.message || SPEC.usage || "");
const repo = resolve(parsed.parsed.flag("--repo") ?? process.cwd());
const config = loadNotifyConfig();
if (
	config?.chatgpt.auto !== true ||
	existsSync(join(repo, ".fleet/chatgpt-auto-paused"))
)
	process.exit(0);
const project = projectIdentity(repo);
const db = openGovernorDb();
db.run(
	"CREATE TABLE IF NOT EXISTS chatgpt_auto_meta (project TEXT PRIMARY KEY, cursor INTEGER NOT NULL)",
);
db.run(
	"CREATE TABLE IF NOT EXISTS chatgpt_auto_runs (identity TEXT PRIMARY KEY, project TEXT NOT NULL, class TEXT NOT NULL, event_id INTEGER NOT NULL, consult_id INTEGER, status TEXT NOT NULL, sent_at INTEGER)",
);
const head = db
	.query("SELECT COALESCE(MAX(id), 0) AS id FROM events")
	.get() as { id: number };
const initial = db
	.query("INSERT OR IGNORE INTO chatgpt_auto_meta VALUES (?, ?)")
	.run(project, head.id);
if (initial.changes > 0) process.exit(0); // opt-in never replays old events
const start = db
	.query("SELECT cursor FROM chatgpt_auto_meta WHERE project = ?")
	.get(project) as { cursor: number };

function itemFor(id: string): AutoItem | null {
	if (!id) return null;
	return db
		.query(
			"SELECT id,title,description,tags,owner_sid,state FROM work_items WHERE project = ? AND id = ?",
		)
		.get(project, id) as AutoItem | null;
}

function launches(id: string): number {
	try {
		const row = db
			.query(
				"SELECT attempt FROM lane_launch_intents WHERE project = ? AND item = ?",
			)
			.get(project, id) as { attempt: number } | null;
		return row?.attempt ?? 0;
	} catch {
		return 0;
	}
}

function benchLanded(ev: AutoEvent): boolean {
	if (ev.kind !== "work.landed") return false;
	const sha = eventPayload(ev).sha;
	if (typeof sha !== "string" || !/^[a-f0-9]{40}$/i.test(sha)) return false;
	const p = Bun.spawnSync(
		["git", "diff-tree", "-m", "--no-commit-id", "--name-only", "-r", sha],
		{ cwd: repo, stdout: "pipe", stderr: "ignore", timeout: 5000 },
	);
	return (
		p.exitCode === 0 && /(?:^|\/)benchmarks\.md$/m.test(p.stdout.toString())
	);
}

function desktopSend(brief: string): boolean {
	const clip = Bun.spawnSync(["pbcopy"], {
		stdin: Buffer.from(brief),
		stdout: "ignore",
		stderr: "ignore",
		timeout: 5000,
	});
	if (clip.exitCode !== 0) return false;
	const script = [
		'tell application "ChatGPT" to activate',
		'tell application "System Events" to tell process "ChatGPT" to keystroke "v" using command down',
		'tell application "System Events" to tell process "ChatGPT" to key code 36',
	];
	const sent = Bun.spawnSync(
		["osascript", ...script.flatMap((line) => ["-e", line])],
		{ stdout: "ignore", stderr: "ignore", timeout: 15000 },
	);
	return sent.exitCode === 0;
}

function classifyEvent(ev: AutoEvent): AutoTrigger | null {
	const p = eventPayload(ev);
	if (ev.kind === "BROADCAST") {
		const source = db
			.query("SELECT role FROM sessions WHERE sid = ? AND project = ?")
			.get(ev.source, project) as { role: string | null } | null;
		if (source?.role !== "coordinator") return null;
	}
	const itemId = String(
		p.item ?? p.work ?? ev.scope?.match(/^W\d+(?:\.\d+)*$/)?.[0] ?? "",
	);
	const item = itemFor(itemId);
	if (
		p.project !== project &&
		!(p.project === undefined && ev.kind === "work.landed" && item) &&
		!(p.project === undefined && ev.kind === "BROADCAST")
	)
		return null;
	return triggerOf(ev, item, item ? launches(item.id) : 0, benchLanded(ev));
}

const events = db
	.query(
		"SELECT id,source,kind,scope,payload FROM events WHERE id > ? ORDER BY id LIMIT 500",
	)
	.all(start.cursor) as AutoEvent[];
for (const ev of events) {
	const trigger = classifyEvent(ev);
	if (trigger)
		db.query(
			"INSERT OR IGNORE INTO chatgpt_auto_runs(identity,project,class,event_id,status) VALUES (?,?,?,?,?)",
		).run(
			trigger.identity,
			project,
			trigger.cls,
			ev.id,
			safeTrigger(trigger) ? "QUEUED" : "SKIPPED",
		);
	start.cursor = ev.id;
}
if (events.length)
	db.query("UPDATE chatgpt_auto_meta SET cursor = ? WHERE project = ?").run(
		start.cursor,
		project,
	);

function ensureConsult(trigger: AutoTrigger, source: string): number {
	const prior = db
		.query("SELECT consult_id FROM chatgpt_auto_runs WHERE identity = ?")
		.get(trigger.identity) as { consult_id: number | null };
	if (prior.consult_id) return prior.consult_id;
	const asker = trigger.item?.owner_sid || source || config.as;
	const question = `Fleet ${trigger.cls} ${trigger.item?.id ?? "project"}: ${trigger.note.slice(0, 1200) || trigger.item?.title || "review trigger"}`;
	return db.transaction(() => {
		const stamp = Date.now();
		const row = db
			.query(
				"INSERT INTO consults (project,asker_sid,expert_sid,question,scope,state,created_at,deadline_at) VALUES (?,?,?,?,?,'OPEN',?,?)",
			)
			.run(
				project,
				asker,
				"chatgpt-auto",
				question,
				trigger.item?.id ?? trigger.scope,
				stamp,
				consultDeadline(stamp),
			);
		const id = Number(row.lastInsertRowid);
		db.query(
			"UPDATE chatgpt_auto_runs SET consult_id = ? WHERE identity = ?",
		).run(id, trigger.identity);
		db.query(
			"INSERT INTO events (ts,source,kind,scope,payload,target) VALUES (?,?,'consult',?,?,?)",
		).run(
			stamp,
			asker,
			trigger.item?.id ?? trigger.scope,
			JSON.stringify({
				consult: `C${id}`,
				project,
				work: trigger.item?.id,
				q: question,
			}),
			"chatgpt-auto",
		);
		return id;
	})();
}

const queued = db
	.query(
		"SELECT identity,event_id,class FROM chatgpt_auto_runs WHERE project = ? AND status = 'QUEUED' ORDER BY event_id LIMIT 20",
	)
	.all(project) as { identity: string; event_id: number; class: string }[];
for (const run of queued) {
	const latest = db
		.query(
			"SELECT MAX(sent_at) AS at FROM chatgpt_auto_runs WHERE project = ? AND class = ?",
		)
		.get(project, run.class) as { at: number | null };
	if (!canSend("QUEUED", latest.at, Date.now())) continue;
	const ev = db
		.query("SELECT id,source,kind,scope,payload FROM events WHERE id = ?")
		.get(run.event_id) as AutoEvent | null;
	const trigger = ev ? classifyEvent(ev) : null;
	if (!trigger || !safeTrigger(trigger)) {
		db.query(
			"UPDATE chatgpt_auto_runs SET status = 'SKIPPED' WHERE identity = ?",
		).run(run.identity);
		continue;
	}
	const cid = ensureConsult(trigger, ev.source);
	db.query("UPDATE chatgpt_auto_runs SET sent_at = ? WHERE identity = ?").run(
		Date.now(),
		run.identity,
	);
	if (desktopSend(composeBrief(trigger, `C${cid}`))) {
		db.query(
			"UPDATE chatgpt_auto_runs SET status = 'SENT' WHERE identity = ?",
		).run(run.identity);
		console.log(`chatgpt-auto: sent C${cid} ${run.class}`);
	} else console.error(`chatgpt-auto: desktop delivery failed for C${cid}`);
}

const answered = db
	.query(
		"SELECT r.identity,c.id,c.asker_sid,c.answer,c.state FROM chatgpt_auto_runs r JOIN consults c ON c.id = r.consult_id WHERE r.project = ? AND r.status = 'SENT' AND c.state IN ('ANSWERED','DECLINED') LIMIT 20",
	)
	.all(project) as {
	identity: string;
	id: number;
	asker_sid: string;
	answer: string | null;
	state: string;
}[];
for (const row of answered) {
	const verdict = verdictFeedback(row.answer ?? "");
	// A review verdict is advice, not observed implementation success.
	const outcome = verdict === "fail" ? "failed" : "unused";
	const args = [
		process.execPath,
		join(import.meta.dir, "coord.ts"),
		"consult-reply",
		`C${row.id}`,
		"--feedback",
		outcome,
		"--as",
		row.asker_sid,
	];
	if (outcome !== "unused")
		args.push(
			"--evidence",
			`ChatGPT final-line verdict for C${row.id}: ${outcome}`,
		);
	const p = Bun.spawnSync(args, {
		cwd: repo,
		stdout: "pipe",
		stderr: "pipe",
		timeout: 15000,
	});
	const output = `${p.stdout.toString()} ${p.stderr.toString()}`;
	if (p.exitCode === 0 || output.includes("feedback already recorded")) {
		db.query(
			"UPDATE chatgpt_auto_runs SET status = 'FEEDBACK' WHERE identity = ?",
		).run(row.identity);
	} else
		console.error(
			`chatgpt-auto: feedback pending C${row.id}: ${output.slice(0, 160)}`,
		);
}
