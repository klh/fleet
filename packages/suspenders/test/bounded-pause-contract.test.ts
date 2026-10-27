import { expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	boundedPauseContract,
	claudePausePrompt,
	claudeStopPause,
	verifiedPauseCheckpoint,
} from "../hooks/lib/claude-pause.ts";
import { pausedLaneFixture } from "./helpers/paused-lane.ts";

const sid = "bounded-pause-fixture";

const stubStore = (state: string | null, capsule: unknown) => ({
	query: (_sql: string) => ({
		get: (key: string) => {
			if (key === `lane.${sid}.state`)
				return state === null ? null : { value: state };
			if (key === `lane.${sid}.capsule`)
				return capsule === null ? null : { value: JSON.stringify(capsule) };
			return null;
		},
	}),
});

test("both pause faces carry the one deterministic bounded contract", () => {
	const contract = boundedPauseContract(sid);
	for (const face of [
		claudePausePrompt(sid, "operator note"),
		claudeStopPause(stubStore("PAUSE_REQUESTED", null), sid, process.cwd()),
		claudeStopPause(
			stubStore("PAUSED", { checkpoint: "f".repeat(40) }),
			sid,
			process.cwd(),
		),
	]) {
		expect(face).toContain(contract);
	}
	// the detours that burned the W1052/W1094/W1131/W1196 pauses are named and
	// forbidden in the contract itself — no model re-derivation of the rules
	expect(contract).toMatch(/Do NOT run qlty fmt, qlty check or tests/);
	expect(contract).toMatch(/do NOT push/);
	expect(contract).toMatch(/do NOT run work done\/release\/retry/);
	// claim/token/context baseline and real-ancestor checkpoint are the contract
	expect(contract).toMatch(/lane-context\.json/);
	expect(contract).toMatch(/real existing ancestor of HEAD/);
});

test("verified pause preserves dirty edits and refuses fabricated checkpoints", () => {
	const dir = mkdtempSync(join(tmpdir(), "bounded-pause-"));
	try {
		const git = (...args: string[]) =>
			execFileSync("git", args, { cwd: dir, encoding: "utf8" });
		git("init", "-q");
		git("config", "user.email", "fixture@example.invalid");
		git("config", "user.name", "Fixture");
		git("commit", "--allow-empty", "-qm", "baseline");
		const head = git("rev-parse", "HEAD").trim();
		writeFileSync(join(dir, "dirty.txt"), "in-flight edit\n");
		// real ancestor over a dirty tree = a verified pause; edits untouched
		expect(verifiedPauseCheckpoint({ checkpoint: head }, dir)).toEqual({
			checkpoint: head,
		});
		expect(
			claudeStopPause(stubStore("PAUSED", { checkpoint: head }), sid, dir),
		).toBe("paused");
		expect(readFileSync(join(dir, "dirty.txt"), "utf8")).toBe(
			"in-flight edit\n",
		);
		expect(git("status", "--porcelain")).toContain("dirty.txt");
		// a real commit that is NOT an ancestor (fabricated safety) is refused
		const tree = execFileSync("git", ["mktree"], {
			cwd: dir,
			encoding: "utf8",
			input: "",
		}).trim();
		const other = execFileSync(
			"git",
			["commit-tree", tree, "-m", "unrelated"],
			{ cwd: dir, encoding: "utf8", input: "" },
		).trim();
		expect(verifiedPauseCheckpoint({ checkpoint: other }, dir)).toBeNull();
		expect(
			claudeStopPause(stubStore("PAUSED", { checkpoint: other }), sid, dir),
		).toContain("PAUSE TURN IS BOUNDED");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("real Stop bounds the pause turn: edits preserved, claim and context untouched", () => {
	const f = pausedLaneFixture();
	try {
		writeFileSync(join(f.cwd, "wip.ts"), "export const wip = 1;\n");
		const contextBefore = readFileSync(
			join(f.cwd, ".fleet/lane-context.json"),
			"utf8",
		);
		f.coord(["fact", "set", `lane.${f.sid}.state`, "PAUSE_REQUESTED"]);
		const missing = f.stop();
		expect(missing.code).toBe(2);
		expect(missing.err).toContain("PAUSE TURN IS BOUNDED");
		expect(missing.err).toContain("pause checkpoint is not verified");
		// the bounded contract, not gate doctrine, is what the lane is told
		expect(missing.err).toContain("Do NOT run qlty fmt, qlty check or tests");
		f.coord([
			"capsule",
			"set",
			`--checkpoint=${f.sha}`,
			"--done=fixture checkpoint",
			"--next=resume later",
		]);
		expect(f.coord(["paused", "--sha", f.sha])).toContain("PAUSED");
		const valid = f.stop();
		expect(valid.code).toBe(0);
		expect(valid.out).toBe("{}");
		// bounded pause: dirty edit survived, claim still holds, baseline intact
		expect(readFileSync(join(f.cwd, "wip.ts"), "utf8")).toBe(
			"export const wip = 1;\n",
		);
		expect(
			execFileSync("git", ["status", "--porcelain"], {
				cwd: f.cwd,
				encoding: "utf8",
			}),
		).toContain("wip.ts");
		expect(JSON.parse(f.work(["show", f.id, "--json"]))).toMatchObject({
			state: "CLAIMED",
			owner_sid: f.sid,
			result_sha: null,
		});
		expect(readFileSync(join(f.cwd, ".fleet/lane-context.json"), "utf8")).toBe(
			contextBefore,
		);
	} finally {
		rmSync(f.home, { recursive: true, force: true });
	}
});
