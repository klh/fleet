// W1225 — lane-brief recall injection: the pre-flight knowledge query + the
// failure error-match line ride every dispatch brief with searchable mission
// terms. Co-situated tests for hooks/lib/brief-recall.ts + its brief.ts wiring.
import { describe, expect, test } from "bun:test";
import { briefRecallLines, recallQuery } from "../hooks/lib/brief-recall.ts";
import { composeBrief } from "../scripts/lib/brief.ts";

const BIN = "/installed/suspenders/bin";

describe("W1225 recall query derivation", () => {
	test("mission terms seed the ranked query", () => {
		const q = recallQuery(
			"◐ W1225 CLAIMED mission placeholder brief.ts lesson.* pre-flight recall",
		);
		expect(q).toContain("brief.ts");
	});

	test("no searchable terms yields an empty query", () => {
		expect(recallQuery("do the thing well, plain prose only")).toBe("");
	});
});

describe("W1225 recall block", () => {
	test("no searchable mission terms yields no recall lines", () => {
		const lines = briefRecallLines({
			missionText: "do the thing well, plain prose only",
			bin: BIN,
		});
		expect(lines).toEqual([]);
	});

	test("pre-flight and failure recall carry the real read faces", () => {
		const all = briefRecallLines({
			missionText:
				"brief.ts composes without any knowledge hint; read_knowledge for the mission package",
			bin: BIN,
		}).join("\n");
		expect(all).toContain(`bun ${BIN}/coord.ts knowledge "`);
		expect(all).toContain("fact list --prefix lesson.");
		expect(all).toContain("FAILURE RECALL:");
		// the query is derived from the mission's own terms
		expect(all).toContain("brief.ts");
	});

	test("empty mission text yields no lines", () => {
		expect(briefRecallLines({ missionText: "", bin: BIN })).toEqual([]);
	});
});

describe("W1225 composeBrief wiring", () => {
	test("dispatch brief carries the recall block", () => {
		const brief = composeBrief({
			item: "W1225",
			showOut:
				"◐ W1225 CLAIMED mission placeholder brief.ts lesson.* pre-flight recall",
			sid: "autow1225-test",
			branch: "suspenders/W1225",
			worktree: "/tmp/nowhere/.worktrees/W1225",
			capsule: null,
		});
		expect(brief).toContain("RECALL (pre-flight):");
		expect(brief).toContain("FAILURE RECALL:");
	});
});
