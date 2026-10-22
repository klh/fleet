// test/attribution-posture.test.ts — W1063: the attribution-posture module
// (extracted from dispatch-next.ts) at its two offline-deterministic
// boundaries — the hub no-credential W463 refusal (refusals push + REFUSED
// lines + kind) and the loud ungoverned-override disclosure (the brief the
// lane reads gets the GOVERNANCE line, both copies). The remaining branches
// (governed mint, front-up, probe-false) stay covered by the dispatch-next
// e2e + governance-decide unit suites — the decisions are pure there.
import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyLaneAttributionPosture } from "../scripts/lib/attribution-posture.ts";

describe("attribution posture (W1063 extraction)", () => {
	test("hub-won + no hub credential + strict → refusal: refusals push, REFUSED lines, kind refused", async () => {
		const dir = mkdtempSync(join(tmpdir(), "suspenders-posture-"));
		const refusals: string[] = [];
		const logLines: string[] = [];
		const out = await applyLaneAttributionPosture({
			sid: "autowz-posture-a",
			item: "WPOSTURE",
			hubWon: "ZZTESTHUB", // absurd label: no token env, no registry row
			hubPick: "ZZTESTHUB",
			hubUrl: "https://zztest.invalid",
			allowUngoverned: false,
			governance: "strict",
			env: {},
			writtenFiles: new Map<string, string>(),
			refusals,
			log: (m) => logLines.push(m),
			brief: "MISSION BODY",
			briefFile: join(dir, "brief.md"),
			wt: dir,
			fleet: dir,
		});
		expect(out.kind).toBe("refused");
		if (out.kind === "refused") {
			expect(out.note).toBe(""); // the call-site hubNote contract
			expect(out.why).toContain("no hub credential");
		}
		expect(refusals).toEqual(["WPOSTURE"]);
		expect(logLines).toHaveLength(1);
		expect(logLines[0]).toContain("REFUSED WPOSTURE → autowz-posture-a");
		expect(logLines[0]).toContain("no hub credential");
	});

	test("hub-won + no hub credential + --allow-ungoverned → loud disclosure into BOTH brief copies", async () => {
		const dir = mkdtempSync(join(tmpdir(), "suspenders-posture-"));
		const briefFile = join(dir, "brief.md");
		const refusals: string[] = [];
		const out = await applyLaneAttributionPosture({
			sid: "autowz-posture-b",
			item: "WPOSTURE",
			hubWon: "ZZTESTHUB",
			hubPick: "ZZTESTHUB",
			hubUrl: "https://zztest.invalid",
			allowUngoverned: true,
			governance: "strict",
			env: {},
			writtenFiles: new Map<string, string>(),
			refusals,
			log: () => {},
			brief: "MISSION BODY",
			briefFile,
			wt: dir,
			fleet: dir,
		});
		expect(out.kind).toBe("disclosed");
		if (out.kind === "disclosed")
			expect(out.note).toContain("UNGOVERNED DISPATCH");
		expect(refusals).toEqual([]); // an override never refuses
		const disclosed = `${readFileSync(briefFile, "utf8")}`;
		expect(disclosed).toContain("MISSION BODY");
		expect(disclosed).toContain("GOVERNANCE: UNGOVERNED DISPATCH");
		const wtCopy = readFileSync(join(dir, ".klh-brief.md"), "utf8");
		expect(wtCopy).toBe(disclosed); // the lane-readable copy rides the disclosure
	});
});
