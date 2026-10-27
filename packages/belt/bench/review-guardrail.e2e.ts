// review-guardrail.e2e.ts — W1477 review human time + revert/incident
// guardrail. Pure logic over fixtures; the git scan runs against a real
// throwaway repo in the OS tmpdir (never under a checkout). Spec bodies stay
// plain JS (playwright spec-shape law).

import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import {
	buildReview,
	classifyRevert,
	evaluateGuardrail,
	gitRevertCommits,
	humanByItem,
	incidentRoot,
	incidentRows,
	landingsFrom,
	loadGuardrailConf,
	parseGitRecords,
	parseGuardrailConfig,
	perLanding,
	revertRows,
	tightenTier,
} from "./review-guardrail.ts";

test.describe("classifyRevert (C156)", () => {
	test("body hex wins; a subject-only revert keeps reverts null @unit", () => {
		const hex = "8f679aac".padEnd(40, "0");
		expect(
			classifyRevert(
				'Revert "W1048: tune gate"',
				`This reverts commit ${hex}.`,
			),
		).toEqual({ reverts: hex });
		expect(classifyRevert('Revert "W1048: tune gate"', "")).toEqual({
			reverts: null,
		});
	});

	test("revert-of-revert and Reapply are re-lands: no row @unit", () => {
		const hex = "a".repeat(40);
		const body = `This reverts commit ${hex}.`;
		expect(classifyRevert('Revert "Revert "W1: x""', body)).toBeNull();
		expect(classifyRevert('Reapply "W1: x"', body)).toBeNull();
	});

	test("ordinary commits are not reverts @unit", () => {
		expect(
			classifyRevert("Revert BELT_TIER default to minimal", "restore tier"),
		).toBeNull();
		expect(classifyRevert("Merge branch 'suspenders/W1'", "")).toBeNull();
	});
});

test.describe("revertRows", () => {
	test("parses records, classifies, dedups by commit, attributes the item @unit", () => {
		const hex = "b".repeat(40);
		const c1 = "1".repeat(40);
		const c2 = "2".repeat(40);
		const out = [
			`${c1}\x1f1761400000\x1fRevert "W1048: tune gate"\x1fThis reverts commit ${hex}.\n\x1e`,
			`\n${c1}\x1f1761400000\x1fRevert "W1048: tune gate"\x1fThis reverts commit ${hex}.\n\x1e`,
			`\n${c2}\x1f1761400100\x1fReapply "W1048: tune gate"\x1fThis reverts commit ${c1}.\n\x1e\n`,
		].join("");
		const records = parseGitRecords(out);
		expect(records.length).toBe(3);
		expect(records[0].ts).toBe(1761400000000);
		const rows = revertRows(records);
		expect(rows.length).toBe(1);
		expect(rows[0].commit).toBe(c1);
		expect(rows[0].reverts).toBe(hex);
		expect(rows[0].work).toBe("W1048");
	});
});

test.describe("landingsFrom", () => {
	test("keeps the project's work.landed rows, deduped per (work, commit) @unit", () => {
		const p = "/repo/.git";
		const events = [
			{
				id: 1,
				ts: 1000,
				kind: "work.landed",
				payload: { project: p, work: "W1", commit: "c1" },
			},
			{
				id: 2,
				ts: 2000,
				kind: "work.landed",
				payload: { project: p, work: "W1", commit: "c1" },
			},
			{
				id: 3,
				ts: 3000,
				kind: "work.landed",
				payload: { project: p, work: "W1", commit: "c2" },
			},
			{
				id: 4,
				ts: 4000,
				kind: "work.landed",
				payload: { project: "/other/.git", work: "W2", commit: "c3" },
			},
			{
				id: 5,
				ts: 5000,
				kind: "work.done",
				payload: { project: p, work: "W3", commit: "c4" },
			},
			{ id: 6, ts: 6000, kind: "work.landed", payload: null },
		];
		expect(landingsFrom(events, p)).toEqual([
			{ work: "W1", commit: "c1", ts: 1000 },
			{ work: "W1", commit: "c2", ts: 3000 },
		]);
	});
});

test.describe("incident roots (C156)", () => {
	test("split children of one incident count once, at the root @unit", () => {
		const p = "/repo/.git";
		const tasks = [
			{ project: p, id: "W1278", parent_id: null, tag: "incident" },
			{ project: p, id: "W1278.1", parent_id: "W1278", tag: "incident,fix" },
			{ project: p, id: "W1278.2", parent_id: "W1278", tag: " incident" },
			{ project: p, id: "W1278.3", parent_id: "W1278", tag: null },
			{ project: p, id: "W5", parent_id: null, tag: "fix" },
			{ project: "/other/.git", id: "W9", parent_id: null, tag: "incident" },
		];
		const landings = [
			{ work: "W1278.1", commit: "m1", ts: 10 },
			{ work: "W1278.2", commit: "m2", ts: 20 },
			{ work: "W1278.3", commit: "m3", ts: 30 },
			{ work: "W5", commit: "m4", ts: 40 },
			{ work: "W9", commit: "m5", ts: 50 },
		];
		expect(incidentRows(landings, tasks, p)).toEqual([
			{ incident: "W1278", work: "W1278.1", commit: "m1", ts: 10 },
		]);
	});

	test("the climb stops at an untagged parent and survives cycles @unit", () => {
		const byId = new Map([
			["A", { project: "p", id: "A", parent_id: "B", tag: "incident" }],
			["B", { project: "p", id: "B", parent_id: "A", tag: "incident" }],
			["C", { project: "p", id: "C", parent_id: "D", tag: "incident" }],
			["D", { project: "p", id: "D", parent_id: null, tag: "fix" }],
		]);
		expect(incidentRoot("C", byId)).toBe("C");
		expect(incidentRoot("A", byId)).toBe("A");
		expect(incidentRoot("D", byId)).toBeNull();
		expect(incidentRoot("missing", byId)).toBeNull();
	});
});

test.describe("human time per landing", () => {
	test("settled answers on the project's landed items count; nothing else does @unit", () => {
		const p = "/repo/.git";
		const t0 = Date.parse("2026-10-20T00:00:00Z");
		const decisions = [
			{
				id: 1,
				project: p,
				task_id: "W1",
				state: "ANSWERED",
				created_ts: t0,
				answered_ts: t0 + 30 * 60_000,
				ack_ts: null,
			},
			{
				id: 2,
				project: p,
				task_id: "W1",
				state: "ACKNOWLEDGED",
				created_ts: t0,
				answered_ts: t0 + 90 * 60_000,
				ack_ts: t0 + 95 * 60_000,
			},
			{
				id: 3,
				project: p,
				task_id: "W1",
				state: "OPEN",
				created_ts: t0,
				answered_ts: null,
				ack_ts: null,
			},
			{
				id: 4,
				project: p,
				task_id: "W1",
				state: "CANCELLED",
				created_ts: t0,
				answered_ts: t0 + 60_000,
				ack_ts: null,
			},
			{
				id: 5,
				project: p,
				task_id: "W2",
				state: "ANSWERED",
				created_ts: t0,
				answered_ts: t0 + 60_000,
				ack_ts: null,
			},
			{
				id: 6,
				project: "/other/.git",
				task_id: "W1",
				state: "ANSWERED",
				created_ts: t0,
				answered_ts: t0 + 60_000,
				ack_ts: null,
			},
			{
				id: 7,
				project: p,
				task_id: null,
				state: "ANSWERED",
				created_ts: t0,
				answered_ts: t0 + 60_000,
				ack_ts: null,
			},
		];
		const by = humanByItem(new Set(["W1"]), decisions, p);
		expect([...by.keys()]).toEqual(["W1"]);
		expect(by.get("W1")).toEqual({ approvals: 2, wait_min: 120 });
		expect(perLanding(2, 4)).toBe(0.5);
		expect(perLanding(1, 3)).toBe(0.3333);
		expect(perLanding(3, 0)).toBeNull();
	});
});

test.describe("parseGuardrailConfig", () => {
	test("accepts owner thresholds and fills defaults @unit", () => {
		expect(parseGuardrailConfig({ revert_rate_max: 0.05 })).toEqual({
			revert_rate_max: 0.05,
			incident_rate_max: null,
			min_landings: 1,
			decision: null,
		});
		expect(
			parseGuardrailConfig({
				revert_rate_max: null,
				incident_rate_max: 0,
				min_landings: 20,
				decision: "#78500",
			}),
		).toEqual({
			revert_rate_max: null,
			incident_rate_max: 0,
			min_landings: 20,
			decision: "#78500",
		});
	});

	test("refuses typos, out-of-range rates and non-objects @unit", () => {
		expect(() => parseGuardrailConfig({ revert_rate: 0.1 })).toThrow(
			"unknown key revert_rate",
		);
		expect(() => parseGuardrailConfig({ revert_rate_max: 5 })).toThrow(
			"revert_rate_max",
		);
		expect(() => parseGuardrailConfig({ incident_rate_max: "0.1" })).toThrow(
			"incident_rate_max",
		);
		expect(() => parseGuardrailConfig({ min_landings: 0 })).toThrow(
			"min_landings",
		);
		expect(() => parseGuardrailConfig({ min_landings: 2.5 })).toThrow(
			"min_landings",
		);
		expect(() => parseGuardrailConfig({ decision: 7 })).toThrow("decision");
		expect(() => parseGuardrailConfig([])).toThrow("not a JSON object");
		expect(() => parseGuardrailConfig(null)).toThrow("not a JSON object");
	});
});

test.describe("evaluateGuardrail", () => {
	test("no owner threshold = unconfigured: measure only, tiers untouched @unit", () => {
		const rates = { landings: 50, revert_rate: 0.5, incident_rate: 0.5 };
		const absent = evaluateGuardrail(rates, {
			path: "/conf.json",
			config: null,
			error: null,
		});
		expect(absent.state).toBe("unconfigured");
		expect(absent.action).toBe("none");
		expect(absent.breaches).toEqual([]);
		expect(absent.tiers).toEqual({
			low: "low",
			medium: "medium",
			high: "high",
		});
		expect(absent.note).toContain("tier action disabled");
		const blank = evaluateGuardrail(rates, {
			path: "/conf.json",
			config: {
				revert_rate_max: null,
				incident_rate_max: null,
				min_landings: 1,
				decision: null,
			},
			error: null,
		});
		expect(blank.state).toBe("unconfigured");
		expect(blank.action).toBe("none");
	});

	test("a refused conf is invalid and stays disabled @unit", () => {
		const v = evaluateGuardrail(
			{ landings: 50, revert_rate: 0.5, incident_rate: null },
			{ path: "/conf.json", config: null, error: "unknown key x" },
		);
		expect(v.state).toBe("invalid");
		expect(v.action).toBe("none");
		expect(v.note).toContain("unknown key x");
	});

	test("too few landings give no verdict @unit", () => {
		const config = {
			revert_rate_max: 0.1,
			incident_rate_max: null,
			min_landings: 20,
			decision: null,
		};
		const conf = { path: "/c", config: config, error: null };
		expect(
			evaluateGuardrail(
				{ landings: 19, revert_rate: 1, incident_rate: 0 },
				conf,
			).state,
		).toBe("insufficient-sample");
		const zero = evaluateGuardrail(
			{ landings: 0, revert_rate: null, incident_rate: null },
			{ path: "/c", config: { ...config, min_landings: 0 }, error: null },
		);
		expect(zero.state).toBe("insufficient-sample");
		expect(zero.action).toBe("none");
	});

	test("at the threshold is within; strictly above trips one tier up @unit", () => {
		const conf = {
			path: "/c",
			config: {
				revert_rate_max: 0.1,
				incident_rate_max: 0.05,
				min_landings: 10,
				decision: "#1",
			},
			error: null,
		};
		const within = evaluateGuardrail(
			{ landings: 10, revert_rate: 0.1, incident_rate: 0.05 },
			conf,
		);
		expect(within.state).toBe("within");
		expect(within.action).toBe("none");
		expect(within.decision).toBe("#1");
		const tripped = evaluateGuardrail(
			{ landings: 10, revert_rate: 0.2, incident_rate: 0.05 },
			conf,
		);
		expect(tripped.state).toBe("tripped");
		expect(tripped.action).toBe("tighten-tiers");
		expect(tripped.tiers).toEqual({
			low: "medium",
			medium: "high",
			high: "high",
		});
		expect(tripped.breaches).toEqual([
			{ metric: "revert_rate", value: 0.2, max: 0.1 },
		]);
		expect(tightenTier("low", 5)).toBe("high");
		expect(tightenTier("high", -1)).toBe("medium");
	});
});

test.describe("buildReview", () => {
	test("windows landings, clamps reverts to landing coverage, folds C156 rows @unit", () => {
		const p = "/repo/.git";
		const day = 86_400_000;
		const since = Date.parse("2026-10-01T00:00:00Z");
		const until = since + 20 * day;
		const first = since + 5 * day;
		const hex = "c".repeat(40);
		const events = [
			{
				id: 1,
				ts: first,
				kind: "work.landed",
				payload: { project: p, work: "W1", commit: "m1" },
			},
			{
				id: 2,
				ts: first + day,
				kind: "work.landed",
				payload: { project: p, work: "W2.1", commit: "m2" },
			},
			{
				id: 3,
				ts: first + 2 * day,
				kind: "work.landed",
				payload: { project: p, work: "W3", commit: "m3" },
			},
			{
				id: 4,
				ts: first + 3 * day,
				kind: "work.landed",
				payload: { project: p, work: "W4", commit: "m4" },
			},
			{
				id: 5,
				ts: until + day,
				kind: "work.landed",
				payload: { project: p, work: "W5", commit: "m5" },
			},
			// C156 rows: a revert the git scan also saw (dedup by commit), one
			// it missed, and an incident root the tag join already counted
			{
				id: 6,
				ts: first + 4 * day,
				kind: "review.incident",
				payload: {
					project: p,
					class: "revert",
					commit: "r1",
					reverts: hex,
					work: "W1",
					subject: 'Revert "W1: x"',
				},
			},
			{
				id: 7,
				ts: first + 4 * day,
				kind: "review.incident",
				payload: {
					project: p,
					class: "revert",
					commit: "r9",
					reverts: null,
					work: "W3",
					subject: 'Revert "W3: y"',
				},
			},
			{
				id: 8,
				ts: first + 4 * day,
				kind: "review.incident",
				payload: {
					project: p,
					class: "incident",
					commit: "m2",
					incident: "W2",
					work: "W2.1",
				},
			},
		];
		const tasks = [
			{ project: p, id: "W2", parent_id: null, tag: "incident" },
			{ project: p, id: "W2.1", parent_id: "W2", tag: "incident" },
		];
		const decisions = [
			{
				id: 1,
				project: p,
				task_id: "W1",
				state: "ANSWERED",
				created_ts: first,
				answered_ts: first + 40 * 60_000,
				ack_ts: null,
			},
		];
		const commits = [
			{
				commit: "r0",
				ts: since + day,
				subject: 'Revert "W0: before coverage"',
				body: "",
			},
			{
				commit: "r1",
				ts: first + 4 * day,
				subject: 'Revert "W1: x"',
				body: `This reverts commit ${hex}.`,
			},
		];
		const review = buildReview({
			project: p,
			sinceMs: since,
			untilMs: until,
			events: events,
			decisions: decisions,
			tasks: tasks,
			commits: commits,
			conf: { path: "/c", config: null, error: null },
		});
		expect(review.landings).toBe(4);
		expect(review.landed_items).toBe(4);
		expect(review.coverage_from).toBe(new Date(first).toISOString());
		expect(review.approvals).toEqual({
			total: 1,
			per_landing: 0.25,
			human_touched_items: 1,
		});
		expect(review.wait).toEqual({
			min_total: 40,
			min_per_landing: 10,
			min_max: 40,
		});
		expect(review.reverts.rows.map((r) => r.commit)).toEqual(["r1", "r9"]);
		expect(review.reverts.rate).toBe(0.5);
		expect(review.incidents.rows.map((r) => r.incident)).toEqual(["W2"]);
		expect(review.incidents.rate).toBe(0.25);
		expect(review.guardrail.state).toBe("unconfigured");
		expect(review.gaps.some((g) => g.includes("work.landed starts"))).toBe(
			true,
		);
	});

	test("a revert-class C156 row carries its incident root too @unit", () => {
		const p = "/repo/.git";
		const landed = { project: p, work: "W5", commit: "m5" };
		// C156: a landing with reverts banks class revert only; its root rides along
		const row = {
			project: p,
			class: "revert",
			commit: "r5",
			reverts: "d".repeat(40),
			work: "W5",
			incident: "W4",
			case: "W6",
		};
		const review = buildReview({
			project: p,
			sinceMs: 0,
			untilMs: 10_000,
			events: [
				{ id: 1, ts: 1000, kind: "work.landed", payload: landed },
				{ id: 2, ts: 2000, kind: "review.incident", payload: row },
			],
			decisions: [],
			tasks: [],
			commits: [],
			conf: { path: "/c", config: null, error: null },
		});
		expect(review.reverts.rows.map((r) => r.commit)).toEqual(["r5"]);
		expect(review.incidents.rows.map((r) => r.incident)).toEqual(["W4"]);
		expect(review.incidents.rows[0].commit).toBe("r5");
	});

	test("no landings: null rates and no verdict, even with thresholds @unit", () => {
		const review = buildReview({
			project: "/repo/.git",
			sinceMs: 0,
			untilMs: 1000,
			events: [],
			decisions: [],
			tasks: [],
			commits: [{ commit: "r1", ts: 500, subject: 'Revert "W1: x"', body: "" }],
			conf: {
				path: "/c",
				config: {
					revert_rate_max: 0.1,
					incident_rate_max: null,
					min_landings: 1,
					decision: null,
				},
				error: null,
			},
		});
		expect(review.landings).toBe(0);
		expect(review.reverts.count).toBe(0);
		expect(review.reverts.rate).toBeNull();
		expect(review.incidents.rate).toBeNull();
		expect(review.approvals.per_landing).toBeNull();
		expect(review.coverage_from).toBeNull();
		expect(review.guardrail.state).toBe("insufficient-sample");
		expect(review.gaps.some((g) => g.includes("no work.landed"))).toBe(true);
	});

	test("a capped decisions feed surfaces as a gap @unit", () => {
		const decisions = Array.from({ length: 200 }, (_, i) => ({
			id: i,
			project: "/repo/.git",
			task_id: null,
			state: "ANSWERED",
			created_ts: 5000 + i,
			answered_ts: 6000 + i,
			ack_ts: null,
		}));
		const review = buildReview({
			project: "/repo/.git",
			sinceMs: 0,
			untilMs: 10_000,
			events: [],
			decisions: decisions,
			tasks: [],
			commits: [],
			conf: { path: "/c", config: null, error: null },
		});
		expect(
			review.gaps.some((g) => g.startsWith("decisions: feed capped at 200")),
		).toBe(true);
	});
});

test.describe("loadGuardrailConf", () => {
	test("absent = unconfigured; broken JSON or unknown keys = refused @unit", () => {
		const dir = mkdtempSync(join(tmpdir(), "w1477-guardrail-"));
		try {
			const absent = join(dir, "absent.json");
			expect(loadGuardrailConf(absent)).toEqual({
				path: absent,
				config: null,
				error: null,
			});
			writeFileSync(
				join(dir, "ok.json"),
				JSON.stringify({ revert_rate_max: 0.1, min_landings: 10 }),
			);
			expect(loadGuardrailConf(join(dir, "ok.json")).config).toEqual({
				revert_rate_max: 0.1,
				incident_rate_max: null,
				min_landings: 10,
				decision: null,
			});
			writeFileSync(join(dir, "bad.json"), "{ not json");
			expect(loadGuardrailConf(join(dir, "bad.json")).error).not.toBeNull();
			writeFileSync(
				join(dir, "typo.json"),
				JSON.stringify({ revert_max: 0.1 }),
			);
			expect(loadGuardrailConf(join(dir, "typo.json")).error).toBe(
				"unknown key revert_max",
			);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

test.describe("gitRevertCommits (real git)", () => {
	test("named and hand reverts row, Reapply and branch-internal undos do not @unit", () => {
		const dir = mkdtempSync(join(tmpdir(), "w1477-git-"));
		try {
			const env = {
				...process.env,
				GIT_AUTHOR_NAME: "t",
				GIT_AUTHOR_EMAIL: "t@example.invalid",
				GIT_COMMITTER_NAME: "t",
				GIT_COMMITTER_EMAIL: "t@example.invalid",
			};
			const git = (args) =>
				spawnSync(
					"git",
					[
						"-c",
						"commit.gpgsign=false",
						"-c",
						"core.hooksPath=/dev/null",
						"-C",
						dir,
						...args,
					],
					{ env: env, encoding: "utf8" },
				);
			expect(git(["init", "-q", "-b", "main"]).status).toBe(0);
			writeFileSync(join(dir, "a.txt"), "1\n");
			expect(git(["add", "a.txt"]).status).toBe(0);
			expect(git(["commit", "-q", "-m", "W7: add a"]).status).toBe(0);
			const landed = git(["rev-parse", "HEAD"]).stdout.trim();
			expect(git(["revert", "--no-edit", "HEAD"]).status).toBe(0);
			expect(git(["revert", "--no-edit", "HEAD"]).status).toBe(0);
			expect(
				git([
					"commit",
					"-q",
					"--allow-empty",
					"-m",
					'Revert "W8: hand-written undo"',
				]).status,
			).toBe(0);
			// git's date parser rejects years >= 2100 — keep the bound near now
			const until = new Date(Date.now() + 86_400_000).toISOString();
			const records = gitRevertCommits(dir, "2000-01-01T00:00:00Z", until);
			expect(records.length).toBe(3);
			const rows = revertRows(records);
			expect(rows.map((r) => r.work)).toEqual(["W8", "W7"]);
			expect(rows[0].reverts).toBeNull();
			expect(rows[1].reverts).toBe(landed);
			// a lane undoes its own commit (not its tip), then reverts landed W7;
			// only the second survives the --no-ff landing (C156 landing rule)
			expect(git(["switch", "-q", "-c", "side"]).status).toBe(0);
			writeFileSync(join(dir, "b.txt"), "1\n");
			expect(git(["add", "b.txt"]).status).toBe(0);
			expect(git(["commit", "-q", "-m", "W9: add b"]).status).toBe(0);
			expect(git(["revert", "--no-edit", "HEAD"]).status).toBe(0);
			expect(git(["revert", "--no-edit", landed]).status).toBe(0);
			expect(git(["switch", "-q", "main"]).status).toBe(0);
			expect(git(["merge", "-q", "--no-ff", "--no-edit", "side"]).status).toBe(
				0,
			);
			const merged = revertRows(
				gitRevertCommits(dir, "2000-01-01T00:00:00Z", until),
			);
			expect(merged.map((r) => r.work).sort()).toEqual(["W7", "W7", "W8"]);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
