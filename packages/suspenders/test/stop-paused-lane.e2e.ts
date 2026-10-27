import { expect, test } from "@playwright/test";
import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { pausedLaneFixture } from "./helpers/paused-lane.ts";

test("real Stop preserves a CLAIMED paused lane and refuses missing or forged pause proofs without completion churn", () => {
	const f = pausedLaneFixture();
	try {
		const fact = (key: string, value: string) =>
			f.coord(["fact", "set", key, value]);
		fact(`lane.${f.sid}.state`, "PAUSE_REQUESTED");
		const missing = f.stop();
		expect(missing.code).toBe(2);
		expect(missing.err).toContain("pause checkpoint is not verified");
		expect(missing.err).not.toContain("One bounded continuation");
		fact(`lane.${f.sid}.state`, "PAUSED");
		fact(
			`lane.${f.sid}.capsule`,
			JSON.stringify({ checkpoint: "f".repeat(40) }),
		);
		const forged = f.stop();
		expect(forged.code).toBe(2);
		expect(forged.err).toContain("coord paused");
		expect(existsSync(join(f.cwd, ".fleet/completion-attempt.json"))).toBe(
			false,
		);
		f.coord([
			"capsule",
			"set",
			`--checkpoint=${f.sha}`,
			"--done=paused fixture",
			"--next=resume later",
		]);
		const note = f.coord([
			"emit",
			"NOTE",
			"--to",
			f.sid,
			"--note",
			"Operator note queued during pause",
		]);
		const valid = f.stop();
		expect(valid.code).toBe(0);
		expect(valid.out).toBe("{}");
		expect(valid.err).not.toContain("knowledge");
		expect(f.coord(["inbox"])).toContain("Operator note queued during pause");
		expect(JSON.parse(f.work(["show", f.id, "--json"]))).toMatchObject({
			state: "CLAIMED",
			owner_sid: f.sid,
			result_sha: null,
		});
		fact(`lane.${f.sid}.state`, "RESUME_READY");
		const resuming = f.stop();
		expect(resuming.code).toBe(2);
		expect(resuming.err).toContain(`coord resumed --as ${f.sid}`);
		expect(resuming.err).not.toContain("One bounded continuation");
		expect(existsSync(join(f.cwd, ".fleet/completion-attempt.json"))).toBe(
			false,
		);
		fact(`lane.${f.sid}.state`, "RUNNING");
		const normal = f.stop();
		expect(normal.code).toBe(2);
		expect(normal.err).toContain("TURN-BOUNDARY INBOX");
		expect(normal.err).not.toContain("pause checkpoint is not verified");
		const eventId = note.match(/#(\d+)/)?.[1];
		expect(eventId).toBeDefined();
		f.coord(["ack", eventId as string]);
		const completion = f.stop();
		expect(completion.code).toBe(2);
		expect(completion.err).toContain("STOP-GATE");
		expect(completion.err).not.toContain("resume reconciliation");
	} finally {
		rmSync(f.home, { recursive: true, force: true });
	}
});
