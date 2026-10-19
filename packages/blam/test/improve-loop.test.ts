import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getStarter } from "../../suspenders/hooks/lib/starter-artifacts.ts";
import {
	promoteStarter,
	writeGrants,
} from "../../suspenders/hooks/lib/starter-distribution.ts";
import { starterSeedPrompt } from "../../suspenders/scripts/lib/lane-starter.ts";
import {
	type ImprovementManifest,
	runImprovement,
} from "../bench/improve/loop.ts";

const roots: string[] = [];
const git = (repo: string, ...args: string[]) => {
	const p = Bun.spawnSync(["git", "-C", repo, ...args], {
		stdout: "pipe",
		stderr: "pipe",
	});
	if (p.exitCode !== 0) throw new Error(p.stderr.toString());
	return p.stdout.toString().trim();
};

function fixture(seed = true, heldoutCount = 3): ImprovementManifest {
	const root = mkdtempSync(join(tmpdir(), "blam-improve-test-"));
	roots.push(root);
	const repo = join(root, "repo");
	Bun.spawnSync(["mkdir", "-p", repo]);
	git(repo, "init", "-q");
	git(repo, "config", "user.email", "test@example.invalid");
	git(repo, "config", "user.name", "BLAM test");
	writeFileSync(join(repo, "README.md"), "fixture\n");
	git(repo, "add", ".");
	git(repo, "commit", "-qm", "fixture");
	writeGrants(repo, { promoters: ["promoter"], revokers: ["promoter"] });
	if (seed)
		promoteStarter(repo, "promoter", {
			id: "lane-orientation",
			version: 1,
			createdAt: new Date().toISOString(),
			instructions: "slow baseline",
			skillVersions: {},
			findings: [],
			sourceRevision: git(repo, "rev-parse", "HEAD"),
			compatibility: { harnesses: ["claude"], models: ["fixture-model"] },
			provenance: {
				authorSid: "seed",
				promotedBy: "promoter",
				evalRef: "seed-eval",
			},
			evals: [],
		});
	const task = { repo, baseRef: "HEAD", task: "Write done to result.txt" };
	return {
		starterRepo: repo,
		starterId: "lane-orientation",
		actor: "promoter",
		model: "fixture-model",
		steps: 1,
		timeoutMs: 10_000,
		outputDir: join(root, "output"),
		probe: { id: "probe", ...task },
		heldout: Array.from(
			{ length: heldoutCount },
			(_, index) => `case-${index}`,
		).map((id) => ({
			id,
			...task,
			task: `Write done to result.txt for case ${id}`,
			judge: [
				"bun",
				"-e",
				"import{readFileSync}from'node:fs';process.exit(readFileSync('result.txt','utf8')==='done\\n'?0:1)",
			],
		})),
		editor: [
			"bun",
			"-e",
			"const p=process.argv[1];console.log(JSON.stringify({instructions:p.startsWith('Propose')?'fast proposal':'fast candidate',lesson:'specific guidance saved tokens'}))",
			"{prompt}",
		],
		executor: [
			"bun",
			"-e",
			"import{writeFileSync}from'node:fs';const p=process.argv[1];writeFileSync('result.txt','done\\n');console.log(JSON.stringify({usage:{total_tokens:p.includes('fast candidate')?100:200}}))",
			"{prompt}",
		],
	};
}

afterEach(() => {
	for (const root of roots.splice(0))
		rmSync(root, { recursive: true, force: true });
});

test("proposes, probes, composes, validates held-out tasks and promotes the live starter", async () => {
	const manifest = fixture(true, 130);
	const result = await runImprovement(manifest);
	expect(result.promotion.promote).toBe(true);
	expect(result.starter.to).toBe(2);
	expect(result.heldout).toHaveLength(130);
	expect(result.lift?.tokensSaved).toBe(100);
	const stored = getStarter(manifest.starterRepo, "lane-orientation", 2);
	expect(stored.ok).toBe(true);
	expect(starterSeedPrompt(join(manifest.starterRepo, ".fleet"))).toContain(
		"fast candidate",
	);
	expect(
		starterSeedPrompt(join(manifest.starterRepo, ".fleet"), "other-model"),
	).not.toContain("fast candidate");
	expect(readFileSync(result.reportFile, "utf8")).toContain("artifactDigest");
}, 60_000);

test("a held-out regression refuses promotion and does not change the starter", async () => {
	const manifest = fixture();
	manifest.executor[2] = manifest.executor[2].replace(
		"'done\\n'",
		"p.includes('fast candidate')?'wrong\\n':'done\\n'",
	);
	const result = await runImprovement(manifest);
	expect(result.promotion.promote).toBe(false);
	expect(result.heldout).toHaveLength(1);
	expect(result.heldout[0]?.candidatePassed).toBe(false);
	expect(getStarter(manifest.starterRepo, "lane-orientation", 2).ok).toBe(
		false,
	);
	expect(starterSeedPrompt(join(manifest.starterRepo, ".fleet"))).toContain(
		"slow baseline",
	);
});

test("first run can establish a promoted starter from the fixed built-in prompt", async () => {
	const manifest = fixture(false, 130);
	const result = await runImprovement(manifest);
	expect(result.starter.from).toBe(0);
	expect(result.starter.to).toBe(1);
	expect(
		starterSeedPrompt(join(manifest.starterRepo, ".fleet"), manifest.model),
	).toContain("fast candidate");
}, 60_000);

test("a three-task pilot records evidence but cannot alter the shared starter", async () => {
	const manifest = fixture();
	const result = await runImprovement(manifest);
	expect(result.promotion.promote).toBe(false);
	expect(result.promotion.why).toContain("130");
	expect(getStarter(manifest.starterRepo, "lane-orientation", 2).ok).toBe(
		false,
	);
});
