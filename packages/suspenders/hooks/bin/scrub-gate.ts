#!/usr/bin/env bun
// hooks/bin/scrub-gate.ts — W236 scrub-gate CLI: the lib/scrub.ts scan
// runnable outside the harness — manual checks, and the .githooks
// pre-commit/pre-push stubs this repo ships (enable per machine:
// `git config core.hooksPath .githooks`). Exit 0 clean, 1 findings,
// 2 usage. SUSPENDERS_SCRUB=0 disables everything.
//   scrub-gate                     staged added lines (cwd repo)
//   scrub-gate --push              upstream…worktree added lines
//   scrub-gate --files <path…>     whole files, 1-based lines
//   scrub-gate hook commit         .githooks/pre-commit entry
//   scrub-gate hook push           .githooks/pre-push entry (stdin ref lines)
//   scrub-gate --json              machine output (findings array)
import { readFileSync } from "node:fs";
import { defineVerb, runCli, type VerbSpec } from "../lib/verb-kit.ts";
import {
	addedDiffLines,
	findingsText,
	scrubAddedLines,
	scrubRules,
	scrubText,
	type ScrubFinding,
} from "../lib/scrub.ts";

const git = (args: string[]): { ok: boolean; out: string } => {
	const r = Bun.spawnSync(["git", ...args], {
		stdout: "pipe",
		stderr: "pipe",
	});
	return {
		ok: r.exitCode === 0,
		out: `${r.stdout.toString()}${r.stderr.toString()}`,
	};
};

// staged added lines (cwd repo); fail-inert → empty findings
const stagedFindings = (): ScrubFinding[] => {
	const d = git(["diff", "--cached", "-U0", "--no-color"]);
	if (!d.ok) return [];
	return scrubAddedLines(addedDiffLines(d.out), scrubRules());
};

// upstream…worktree added lines; no upstream → nothing (the commit
// surface already gated that content)
const pushFindings = (): ScrubFinding[] => {
	const up = git([
		"rev-parse",
		"--abbrev-ref",
		"--symbolic-full-name",
		"@{upstream}",
	]);
	if (!up.ok || !up.out.trim()) return [];
	const d = git(["diff", `${up.out.trim()}...`, "-U0", "--no-color"]);
	if (!d.ok) return [];
	return scrubAddedLines(addedDiffLines(d.out), scrubRules());
};

// .githooks/pre-push leg: stdin carries `local_ref local_sha remote_ref
// remote_sha` lines; a zeros remote sha (new remote branch) falls back to
// the upstream view, deletions skip, plumbing failure falls back too.
// No ref lines at all → the staged check still runs.
const hookPushFindings = (): ScrubFinding[] => {
	let refs = "";
	try {
		refs = readFileSync(0, "utf8");
	} catch {
		refs = ""; // no piped stdin → fall through to staged
	}
	const out: ScrubFinding[] = [];
	let sawRef = false;
	for (const line of refs.split("\n")) {
		const parts = line.trim().split(/\s+/);
		const localRef = parts[0] ?? "";
		const localSha = parts[1] ?? "";
		const remoteSha = parts[3] ?? "";
		if (!localRef || localRef === "(delete)") continue;
		sawRef = true;
		const d =
			/^0+$/.test(remoteSha) || !remoteSha
				? pushFindings()
				: scrubDiffRange(localSha, remoteSha);
		out.push(...d);
	}
	return sawRef ? out : stagedFindings();
};

const scrubDiffRange = (
	localSha: string,
	remoteSha: string,
): ScrubFinding[] => {
	const d = git(["diff", `${remoteSha}..${localSha}`, "-U0", "--no-color"]);
	if (!d.ok) return pushFindings(); // plumbing failure → upstream view
	return scrubAddedLines(addedDiffLines(d.out), scrubRules());
};

// whole-file scan (--files mode): unreadable paths skip silently.
const fileFindings = (paths: string[]): ScrubFinding[] => {
	const rules = scrubRules();
	const out: ScrubFinding[] = [];
	for (const p of paths) {
		try {
			out.push(...scrubText(readFileSync(p, "utf8"), rules, p));
		} catch {
			// unreadable → skip
		}
	}
	return out;
};

// emit findings; the exit code IS the verdict (0 clean, 1 blocked, 2 usage)
const emit = (found: ScrubFinding[], json: boolean): number => {
	if (json) {
		console.log(JSON.stringify(found, null, 2));
	} else if (found.length > 0) {
		console.error(
			`scrub-gate: ${found.length} finding(s) — blocked:\n${findingsText(found)}`,
		);
	} else {
		console.log("scrub-gate: clean");
	}
	return found.length > 0 ? 1 : 0;
};

const VERBS: VerbSpec[] = [
	defineVerb({
		name: "staged",
		usage: "usage: scrub-gate staged — staged added lines (cwd repo)",
		switches: ["--json"],
	}),
	defineVerb({
		name: "push",
		usage: "usage: scrub-gate push — upstream…worktree added lines",
		switches: ["--json"],
	}),
	defineVerb({
		name: "files",
		usage: "usage: scrub-gate files <path…> — whole files, 1-based lines",
		minPos: 1,
		switches: ["--json"],
	}),
	defineVerb({
		name: "hook",
		usage: "usage: scrub-gate hook <commit|push> — the .githooks entry faces",
		minPos: 1,
		switches: ["--json"],
	}),
];

await runCli({
	prog: "scrub-gate",
	about:
		"scrub-gate — W236 secret/path scrub scanner; the exit code IS the verdict.",
	verbs: VERBS,
	dispatch: (name, p) => {
		const json = p.rest.includes("--json");
		if (name === "staged") process.exitCode = emit(stagedFindings(), json);
		else if (name === "push") process.exitCode = emit(pushFindings(), json);
		else if (name === "files")
			process.exitCode = emit(fileFindings(p.pos), json);
		else {
			const mode = p.pos[0] ?? "";
			process.exitCode =
				mode === "push"
					? emit(hookPushFindings(), json)
					: mode === "commit"
						? emit(stagedFindings(), json)
						: 2;
		}
	},
});
