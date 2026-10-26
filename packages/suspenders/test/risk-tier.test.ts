import { afterEach, expect, test } from "bun:test";
import {
	mkdirSync,
	mkdtempSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	candidatePaths,
	classifyRiskTier,
	emitRiskDecision,
} from "../hooks/lib/gates/risk-tier.ts";
import { openMemoryStore } from "../hooks/lib/govdb/govdb-store.ts";

const cleanups: (() => void)[] = [];
afterEach(() => {
	for (const cleanup of cleanups.splice(0)) cleanup();
});

function gitFixture(name: string) {
	const repo = realpathSync(mkdtempSync(join(tmpdir(), `fleet-${name}-`)));
	cleanups.push(() => rmSync(repo, { recursive: true, force: true }));
	const git = (...args: string[]) => {
		const p = Bun.spawnSync(["git", ...args], {
			cwd: repo,
			stdout: "pipe",
			stderr: "pipe",
		});
		if (p.exitCode !== 0) throw new Error(p.stderr.toString());
		return p.stdout.toString().trim();
	};
	git("init", "-b", "main");
	git("config", "user.name", "fixture");
	git("config", "user.email", "fixture@example.invalid");
	return { repo, git };
}

test("docs-only change is low with zero approvals", () => {
	const risk = classifyRiskTier(["README.md", "docs/guide.md"]);
	expect(risk.tier).toBe("low");
	expect(risk.approvals).toBe(0);
	expect(risk.reasons).toContain("docs/tests-only change");
});

test("test-shaped changes are low — dirs and file suffixes", () => {
	for (const paths of [
		["packages/app/test/thing.test.ts"],
		["packages/app/e2e/thing.e2e.ts"],
		["packages/app/tests/spec.ts"],
		["packages/app/thing.spec.ts"],
	]) {
		expect(classifyRiskTier(paths).tier).toBe("low");
	}
});

test("ordinary product change is medium with one approval", () => {
	const risk = classifyRiskTier(["packages/app/src/thing.ts"]);
	expect(risk.tier).toBe("medium");
	expect(risk.approvals).toBe(1);
});

test("high tells classify high — the referee and its perimeter", () => {
	const cases: [string, string][] = [
		[".github/workflows/ci.yml", "repo governance/CI workflow"],
		[".github/CODEOWNERS", "repo governance/CI workflow"],
		[".githooks/pre-push", "commit/push hooks"],
		["install.sh", "installer"],
		["packages/suspenders/deploy/hubctl.ts", "hub infra"],
		["packages/suspenders/hooks/gates/files.ts", "check tools"],
		["packages/suspenders/hooks/lib/scrub.ts", "scrub gate"],
		["tests/law-guards.test.ts", "law-guard tests"],
		["com.suspenders.board.plist", "launchd plists"],
		["packages/x/release-notes.ts", "release tooling"],
	];
	for (const [path, tell] of cases) {
		const risk = classifyRiskTier([path]);
		expect(risk.tier).toBe("high");
		expect(risk.approvals).toBe(2);
		expect(risk.reasons[0]).toContain(tell);
	}
});

test("high wins over low shapes in a mixed change", () => {
	const risk = classifyRiskTier([
		"README.md",
		"packages/suspenders/hooks/lib/scrub.ts",
	]);
	expect(risk.tier).toBe("high");
	expect(risk.reasons[0]).toContain("scrub");
});

test("flagged-additive is caller-declared, never diff-inferred", () => {
	// a brand-new product file is "purely additive" but stays ordinary product
	expect(classifyRiskTier(["packages/app/src/new-thing.ts"]).tier).toBe(
		"medium",
	);
	const flagged = classifyRiskTier(["packages/app/src/new-thing.ts"], {
		flaggedAdditive: true,
	});
	expect(flagged.tier).toBe("low");
	expect(flagged.approvals).toBe(0);
	// flagged-additive never downgrades a high tell
	const flaggedHigh = classifyRiskTier(
		[
			"packages/app/src/new-thing.ts",
			"packages/suspenders/hooks/gates/files.ts",
		],
		{ flaggedAdditive: true },
	);
	expect(flaggedHigh.tier).toBe("high");
	expect(classifyRiskTier([]).tier).toBe("low");
});

test("candidatePaths reads the branch delta the review context reads", () => {
	const { repo, git } = gitFixture("risk-tier");
	mkdirSync(join(repo, "docs"), { recursive: true });
	git("commit", "--allow-empty", "-m", "base");
	git("checkout", "-b", "suspenders/W1");
	writeFileSync(join(repo, "docs/note.md"), "note\n");
	git("add", ".");
	git("commit", "-m", "docs change");
	const paths = candidatePaths(repo, git("rev-parse", "main"), "suspenders/W1");
	expect(paths).toEqual(["docs/note.md"]);
});

test("emitRiskDecision dedupes per project+commit+tier", () => {
	const { repo, git } = gitFixture("risk-decision");
	git("commit", "--allow-empty", "-m", "base");
	const db = openMemoryStore();
	cleanups.push(() => db.close());
	db.run(
		"CREATE TABLE events (id INTEGER PRIMARY KEY, ts INTEGER, source TEXT, kind TEXT, scope TEXT, payload TEXT, target TEXT)",
	);
	const emit = () =>
		emitRiskDecision(db, "project", "W1", repo, "main", {
			tier: "high",
			approvals: 2,
			reasons: ["x"],
		});
	expect(emit()).toBe(true);
	expect(emit()).toBe(false);
	const rows = db
		.query("SELECT payload FROM events WHERE kind = 'NEED_DECISION'")
		.all() as { payload: string }[];
	expect(rows).toHaveLength(1);
	const payload = JSON.parse(rows[0]?.payload ?? "{}") as {
		project: string;
		note: string;
		tier: string;
		risk: string;
	};
	expect(payload.project).toBe("project");
	expect(payload.project).toBe("project");
	expect(payload.tier).toBe("high");
	const riskPayload = JSON.parse(payload.risk) as { commit: string };
	expect(riskPayload.commit).toMatch(/^[0-9a-f]{40,64}$/);
	expect(payload.note).toContain("2 human approval(s)");
	// a new tier on the same commit is a separate decision
	expect(
		emitRiskDecision(db, "project", "W1", repo, "main", {
			tier: "medium",
			approvals: 1,
			reasons: ["y"],
		}),
	).toBe(true);
});
