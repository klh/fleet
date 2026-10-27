#!/usr/bin/env bun
// scripts/release.ts — W1303.6: the one-version release verb (P6). The
// standard's `tools/src/release.ts` adapted to fleet law: bump EVERY
// package manifest + internal @klh/* dep spec in ONE commit, tag
// vMAJOR.MINOR.PATCH (annotated), prepend the CHANGELOG.md release line
// with the merged item ids. The machine stack.json pin stays operator-
// owned — this only RENDERS the hint (install tail prints the same line).
//   bun scripts/release.ts status              # agreement + tag + machine pin
//   bun scripts/release.ts plan [--bump kind]  # the release plan, no writes
//   bun scripts/release.ts cut --bump kind --items W1303,W1301 [--push]
//                                             # apply: bump+changelog+commit+tag
// Dry-run is the default posture: `cut` without --yes prints the plan and
// exits. `--push` pushes the tag (bare, the fleet push-gate contract).
import { join } from "node:path";
import { defineVerb, runCli } from "../hooks/lib/verb-kit.ts";
import {
	agreement,
	applyRelease,
	type BumpKind,
	latestTag,
	machineVersionHint,
	planRelease,
	spawnGitRunner,
} from "./lib/release-version.ts";

const repo = join(import.meta.dir, "..", "..", "..");
const git = spawnGitRunner(repo);
const BUMPS: BumpKind[] = ["major", "minor", "patch"];

const parseBump = (v: string | null): BumpKind => {
	if (v === null || !BUMPS.includes(v as BumpKind))
		throw new Error(`release: --bump must be one of ${BUMPS.join("|")}`);
	return v as BumpKind;
};

const renderPlan = (
	p: ReturnType<typeof planRelease>,
	items: string[],
): string => {
	const lines = [
		`current ${p.current} → next ${p.next}  (tag ${p.tag})`,
		`manifests (${p.manifests.length}):`,
		...p.manifests.map((m) => `  ${m.rel}`),
	];
	if (p.depRewrites.length) {
		lines.push("internal @klh/* dep specs rewritten:");
		for (const d of p.depRewrites)
			for (const [name, old] of Object.entries(d.deps))
				lines.push(`  ${d.rel}: ${name} ${old} → ${p.next}`);
	} else lines.push("internal @klh/* dep specs: none declared");
	lines.push(
		p.changelogRel
			? `CHANGELOG: prepend "## ${p.next}" with ${items.length} item id(s)`
			: "CHANGELOG: none (repo has no CHANGELOG.md — nothing prepended)",
	);
	return lines.join("\n");
};

const status = defineVerb({
	name: "status",
	usage: "usage: release status",
	run: () => {
		const agr = agreement(repo);
		const tag = latestTag(git);
		const hint = machineVersionHint(tag?.slice(1) ?? undefined);
		const rows = [
			`manifest agreement: ${agr.ok ? "OK" : "DRIFT"}`,
			agr.current !== null ? `  version: ${agr.current}` : "  version: (none)",
			...agr.drift.map(
				(d) => `  drift: ${d.rel} @ ${d.version || "(no version)"}`,
			),
			`latest tag: ${tag ?? "(none)"}`,
			`tag ${tag ? (agr.current !== null && `v${agr.current}` === tag ? "matches" : "DIFFERS from") : "missing for"} the manifest version`,
			hint.line,
		];
		console.log(rows.join("\n"));
		return agr.ok ? 0 : 1;
	},
});

const plan = defineVerb({
	name: "plan",
	usage: "usage: release plan [--bump major|minor|patch] [--to X.Y.Z]",
	flags: ["--bump", "--to"],
	switches: ["--json"],
	run: (p) => {
		const rel = planRelease(repo, {
			to: p.flag("--to") ?? undefined,
			kind: parseBump(p.flag("--bump") ?? "patch"),
		});
		if (p.flag("--json") !== null) {
			console.log(JSON.stringify(rel, null, "\t"));
			return 0;
		}
		console.log(renderPlan(rel, []));
		return 0;
	},
});

const cut = defineVerb({
	name: "cut",
	usage:
		"usage: release cut --bump <kind> --items <ids> [--to X.Y.Z] [--yes] [--push]",
	flags: ["--bump", "--items", "--to"],
	switches: ["--yes", "--push"],
	reqFlags: ["--bump", "--items"],
	run: (p) => {
		const items = (p.flag("--items") as string)
			.split(",")
			.map((s) => s.trim())
			.filter(Boolean);
		if (!items.length)
			throw new Error("release: --items needs at least one item id");
		const rel = planRelease(repo, {
			to: p.flag("--to") ?? undefined,
			kind: parseBump(p.flag("--bump")),
		});
		if (!p.flag("--yes")) {
			console.log(`DRY RUN (pass --yes to apply):\n${renderPlan(rel, items)}`);
			return 0;
		}
		const done = applyRelease(repo, rel, items);
		if (p.flag("--push") !== null) {
			const push = git(["push", "origin", `refs/tags/${done.tag}`]);
			if (push.code !== 0)
				throw new Error(`release: push failed: ${push.err.trim()}`);
		}
		console.log(
			[
				`released ${done.tag} — commit ${done.commit.slice(0, 12)} on ${done.files.length} files`,
				machineVersionHint(rel.next).line,
			].join("\n"),
		);
		return 0;
	},
});

await runCli({
	prog: "release",
	about: "one-version release: status | plan | cut",
	verbs: [status, plan, cut],
	epilog:
		"machine stack.json pin is operator-owned; this tool renders the hint only",
});
