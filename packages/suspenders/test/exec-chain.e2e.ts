// test/exec-chain.test.ts — W183.2: the executor chain picker (decomposed
// out of dispatch-next.ts by the 1500-line law). The default branch walks
// the ordered default_executors as a fallback chain — attempt indexes it,
// the same-bin tail rides --fallback-model, claude stays the appended last
// resort, untranslatable feed values drop out. .prefer chains outrank
// defaults, unchanged.
import { expect, test } from "@playwright/test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execPick } from "../scripts/lib/exec-chain.ts";
import { specialistByPort } from "../hooks/board/local-swarm.ts";

const HOME = mkdtempSync(join(tmpdir(), "w183-chain-home-"));
const REPO = mkdtempSync(join(tmpdir(), "w183-chain-repo-"));
mkdirSync(join(HOME, ".claude", "local-llm"), { recursive: true });
const REAL_HOME = process.env.HOME;
process.env.HOME = HOME;

const settingsFile = join(
	HOME,
	".claude",
	"local-llm",
	"suspenders-board.json",
);
const pick = (attempt: number, de: string[], enabled?: string[]) => {
	writeFileSync(
		settingsFile,
		JSON.stringify(
			enabled
				? { default_executors: de, enabled_executors: enabled }
				: { default_executors: de },
		),
	);
	return execPick(attempt, REPO);
};
// W620: same settings write, pick reads the trust tally
const pickCv = (attempt: number, de: string[], cv: Map<string, number>) => {
	writeFileSync(settingsFile, JSON.stringify({ default_executors: de }));
	return execPick(attempt, REPO, cv);
};

test.afterAll(() => {
	process.env.HOME = REAL_HOME;
	rmSync(HOME, { recursive: true, force: true });
	rmSync(REPO, { recursive: true, force: true });
});

test.describe("W183.2 default-executor fallback chain (execPick default branch)", () => {
	test("empty list: claude only, chain of one", () => {
		const p = pick(0, []);
		expect(p.agent).toBe("claude");
		expect(p.model).toBeNull();
		expect(p.chainLen).toBe(1);
		expect(p.fallbackModels).toEqual([]);
	});

	test("attempt walks the list; overrun parks on the last entry", () => {
		const a0 = pick(0, ["llm:desktop:glm-x", "claude"]);
		expect(a0.agent).toBe("llm:desktop:glm-x");
		expect(a0.model).toBe("glm-x");
		expect(a0.chainIdx).toBe(0);
		expect(a0.chainLen).toBe(2);
		const a1 = pick(1, ["llm:desktop:glm-x", "claude"]);
		expect(a1.agent).toBe("claude");
		expect(a1.chainIdx).toBe(1);
		expect(pick(9, ["llm:desktop:glm-x", "claude"]).chainIdx).toBe(1);
	});

	test("same-bin tail rides --fallback-model; null-model claude excluded", () => {
		const p = pick(0, ["llm:desktop:glm-x", "glm-flash2", "claude"]);
		expect(p.agent).toBe("llm:desktop:glm-x");
		expect(p.fallbackModels).toEqual(["glm-flash2"]);
		expect(p.chainLen).toBe(3);
	});

	test("feed values translate through the swarm inventory", () => {
		const p = pick(0, ["llm:local:8901", "claude"]);
		expect(p.model).toBe(specialistByPort(8901)?.model);
		expect(p.agent).toBe("llm:local:8901");
	});

	test("untranslatable feed values drop out of the chain", () => {
		const p = pick(0, ["llm:local:9999", "claude"]);
		expect(p.agent).toBe("claude");
		expect(p.chainLen).toBe(1);
	});

	test("enabled_executors filters; fully blocked list falls to plain claude", () => {
		expect(pick(0, ["llm:desktop:glm-x", "claude"], ["claude"]).agent).toBe(
			"claude",
		);
		const blocked = pick(0, ["llm:desktop:glm-x"], []);
		expect(blocked.agent).toBe("claude");
		expect(blocked.chainLen).toBe(0);
	});

	test(".prefer file chain still outranks the defaults", () => {
		writeFileSync(join(REPO, ".prefer"), "must=glm-5.3-flash\n");
		const p = execPick(0, REPO);
		expect(p.agent).toBe("glm-5.3-flash");
		expect(p.preference).toEqual({
			source: "dotfile",
			directive: "must",
			line: 1,
			index: 0,
			target: "glm-5.3-flash",
			can: "absent",
		});
		expect(p.chainLen).toBe(1);
		expect(p.chainIdx).toBe(0);
		rmSync(join(REPO, ".prefer"));
	});
});

test.describe("W620 trust tally reorders the DEFAULT ladder only", () => {
	test("cv desc reorders; claude stays last with no data (stable, missing = 0)", () => {
		// [glm-x, glm-flash2, claude], only glm-flash2 trusted: it jumps first,
		// ties keep original relative order (glm-x before claude)
		const p = pickCv(
			0,
			["llm:desktop:glm-x", "glm-flash2", "claude"],
			new Map([["glm-flash2", 7]]),
		);
		expect(p.agent).toBe("glm-flash2");
		expect(p.chainIdx).toBe(0);
		expect(p.chainLen).toBe(3);
		expect(p.fallbackModels).toEqual(["glm-x"]);
		// empty tally = no reorder: claude stays the appended last resort
		const q = pickCv(0, ["llm:desktop:glm-x", "claude"], new Map());
		expect(q.agent).toBe("llm:desktop:glm-x");
		expect(q.chainIdx).toBe(0);
	});

	test(".prefer MUST chain is never reordered (W228), cv or not", () => {
		writeFileSync(join(REPO, ".prefer"), "must=glm-5.3-flash\n");
		const p = pickCv(0, ["llm:desktop:glm-x"], new Map([["glm-flash2", 9]]));
		expect(p.agent).toBe("glm-5.3-flash");
		expect(p.name).toBe("glm-5.3-flash");
		rmSync(join(REPO, ".prefer"));
	});
});

test.describe("W813 chain semantics: comma-lists, hub targets, position law, can=", () => {
	test("must comma-list expands; left target tried first within the line", () => {
		writeFileSync(join(REPO, ".prefer"), "must=glm-5.3-flash,glm-flash2\n");
		const p = execPick(0, REPO);
		expect(p.name).toBe("glm-5.3-flash");
		expect(p.chainLen).toBe(2);
		expect(p.fallbackModels).toEqual(["glm-flash2"]);
		expect(execPick(1, REPO).name).toBe("glm-flash2");
		rmSync(join(REPO, ".prefer"));
	});

	test("comma-list alongside repeated must lines: later line wins, in-line order kept", () => {
		writeFileSync(
			join(REPO, ".prefer"),
			"must=glm-5.3-flash,glm-flash2\nmust=fable\n",
		);
		const p = execPick(0, REPO);
		expect(p.name).toBe("fable");
		// tail order: line-1 entries keep left-first within the line
		expect(p.fallbackModels).toEqual(["glm-5.3-flash", "glm-flash2"]);
		expect(execPick(1, REPO).name).toBe("glm-5.3-flash");
		expect(execPick(9, REPO).name).toBe("glm-flash2");
		rmSync(join(REPO, ".prefer"));
	});

	test("W813 position law: prefer= BELOW must= genuinely overrides", () => {
		writeFileSync(
			join(REPO, ".prefer"),
			"must=glm-5.3-flash\nprefer=glm-flash2\n",
		);
		expect(execPick(0, REPO).name).toBe("glm-flash2");
		expect(execPick(0, REPO).preference.directive).toBe("prefer");
		expect(execPick(0, REPO).preference.line).toBe(2);
		expect(execPick(1, REPO).name).toBe("glm-5.3-flash");
		rmSync(join(REPO, ".prefer"));
	});

	test("must naming a known hub rides that hub, default executor, no model pin", () => {
		const hubsFile = join(HOME, "hubs.json");
		writeFileSync(
			hubsFile,
			JSON.stringify({ NAS: { candidates: ["https://nas.example:4101"] } }),
		);
		process.env.SUSPENDERS_HUBS_FILE = hubsFile;
		try {
			writeFileSync(join(REPO, ".prefer"), "must=nas\n");
			const p = execPick(0, REPO);
			expect(p.name).toBe("nas");
			expect(p.model).toBeNull();
			expect(p.bin).toBe("claude");
			expect(p.hub).toBe("nas");
			expect(p.agent).toBe("[NAS] nas");
		} finally {
			rmSync(join(REPO, ".prefer"));
			delete process.env.SUSPENDERS_HUBS_FILE;
		}
	});

	test("unknown token is still a model pin, never a hub", () => {
		writeFileSync(join(REPO, ".prefer"), "must=nosuchhub-xyz\n");
		const p = execPick(0, REPO);
		expect(p.model).toBe("nosuchhub-xyz");
		expect(p.hub).toBeNull();
		rmSync(join(REPO, ".prefer"));
	});

	test("doable can= (cv-proven model) invalidates the must lines", () => {
		writeFileSync(
			join(REPO, ".prefer"),
			"must=glm-5.3-flash\ncan=glm-flash2\n",
		);
		const cv = new Map([["glm-flash2", 5]]);
		const p = execPick(0, REPO, cv);
		expect(p.name).toBe("glm-flash2");
		expect(p.chainLen).toBe(1);
		expect(p.preference).toEqual({
			source: "dotfile",
			directive: "can",
			line: 2,
			index: 0,
			target: "glm-flash2",
			can: "active",
		});
		rmSync(join(REPO, ".prefer"));
	});

	test("can= invalidates musts regardless of line order", () => {
		writeFileSync(
			join(REPO, ".prefer"),
			"can=glm-flash2\nmust=glm-5.3-flash\n",
		);
		const p = execPick(0, REPO, new Map([["glm-flash2", 5]]));
		expect(p.name).toBe("glm-flash2");
		expect(p.chainLen).toBe(1);
		rmSync(join(REPO, ".prefer"));
	});

	test("unproven can= (no cv) vanishes and MUST stands unchanged", () => {
		writeFileSync(
			join(REPO, ".prefer"),
			"must=glm-5.3-flash\ncan=glm-flash2\n",
		);
		const p = execPick(0, REPO, new Map());
		expect(p.name).toBe("glm-5.3-flash");
		expect(p.chainLen).toBe(1);
		expect(p.preference.can).toBe("unavailable");
		rmSync(join(REPO, ".prefer"));
	});

	test("quota-exhausted can= is not doable, MUST stands", () => {
		writeFileSync(join(REPO, ".prefer"), "must=fable\ncan=glm-5.3-flash\n");
		const cv = new Map([["glm-5.3-flash", 5]]);
		const quota = new Map([["zai", "quota exceeded"]]);
		const p = execPick(0, REPO, cv, quota);
		expect(p.name).toBe("fable");
		expect(p.chainLen).toBe(1);
		rmSync(join(REPO, ".prefer"));
	});

	test("doable can= hub target invalidates must and heads the chain", () => {
		const hubsFile = join(HOME, "hubs.json");
		writeFileSync(
			hubsFile,
			JSON.stringify({ NAS: { candidates: ["https://nas.example:4101"] } }),
		);
		process.env.SUSPENDERS_HUBS_FILE = hubsFile;
		try {
			writeFileSync(join(REPO, ".prefer"), "must=glm-5.3-flash\ncan=nas\n");
			const p = execPick(0, REPO);
			expect(p.name).toBe("nas");
			expect(p.hub).toBe("nas");
			expect(p.model).toBeNull();
			expect(p.chainLen).toBe(1);
		} finally {
			rmSync(join(REPO, ".prefer"));
			delete process.env.SUSPENDERS_HUBS_FILE;
		}
	});

	test("can= + prefer interplay: kept directives still order by position", () => {
		writeFileSync(
			join(REPO, ".prefer"),
			"must=glm-5.3-flash\ncan=glm-flash2\nprefer=fable\n",
		);
		const p = execPick(0, REPO, new Map([["glm-flash2", 5]]));
		expect(p.name).toBe("fable");
		expect(p.fallbackModels).toEqual(["glm-flash2"]);
		rmSync(join(REPO, ".prefer"));
	});
});
