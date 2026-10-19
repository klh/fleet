#!/usr/bin/env bun
// hooks/bin/doctor.ts — W842 clean-machine onboarding doctor (verb-kit door).
// `check` verifies onboarding components statically from their FINAL
// locations; `smoke` exercises the live control plane (board read face, gate
// scoped-key mint/verify/revoke roundtrip). Exit: 0 all pass, 0< warn, 2 fail.
import { join, resolve } from "node:path";
import {
	readAdminKey,
	runChecks,
	smokeBoard,
	smokeGateRoundtrip,
	worstStatus,
	type CheckResult,
	type DoctorContext,
	type SmokeResult,
} from "../lib/doctor.ts";
import { defineVerb, runCli, type Parsed } from "../lib/verb-kit.ts";

const home = process.env.HOME ?? "";

const emitRows = (rows: CheckResult[], asJson: boolean, repo: string): number => {
	if (asJson)
		console.log(JSON.stringify({ repo, origin: import.meta.path, checks: rows }));
	else for (const r of rows) console.log(`[${r.status}] ${r.id}: ${r.detail}`);
	const worst = worstStatus(rows);
	return worst === "pass" ? 0 : worst === "warn" ? 1 : 2;
};

const runSmoke = async (p: Parsed, asJson: boolean): Promise<number> => {
	const boardBase =
		p.flag("--board-url") ?? process.env.KLH_BOARD_URL ?? "http://127.0.0.1:7799";
	const gateBase =
		p.flag("--gate-url") ?? process.env.KLH_GATE_URL ?? "http://127.0.0.1:4101";
	const key = readAdminKey(`${home}/.claude/local-llm/belt.env`);
	const rows = await Promise.all([
		smokeBoard(boardBase),
		key
			? smokeGateRoundtrip(gateBase, key)
			: Promise.resolve({
					id: "scoped-keys",
					status: "fail" as const,
					detail: "no BUCKLE_ADMIN_KEY readable from belt.env",
				}),
	]);
	if (asJson)
		console.log(JSON.stringify({ origin: import.meta.path, smoke: rows }));
	else for (const r of rows) console.log(`[${r.status}] ${r.id}: ${r.detail}`);
	const worst = worstStatus(rows);
	return worst === "pass" ? 0 : worst === "warn" ? 1 : 2;
};

const VERBS = [
	defineVerb({
		name: "check",
		usage:
			'usage: doctor check [--repo <dir>] [--json] — static onboarding checks (bun, agent CLI, gateway credentials, repo rules, project identity)',
		flags: ["--repo"],
		switches: ["--json"],
	}),
	defineVerb({
		name: "smoke",
		usage:
			'usage: doctor smoke [--repo <dir>] [--board-url <url>] [--gate-url <url>] --json — live board + scoped-key roundtrip',
		flags: ["--repo", "--board-url", "--gate-url"],
		switches: ["--json"],
	}),
];

await runCli({
	prog: "doctor",
	about:
		"doctor — W842 clean-machine onboarding doctor: check + smoke from final installed locations.",
	verbs: VERBS,
	dispatch: (name, p): number | Promise<number> => {
		const repo = resolve(p.flag("--repo") ?? process.cwd());
		const asJson = p.all("--json").length > 0;
		const ctx: DoctorContext = {
			repo,
			home,
			modulePath: import.meta.path,
			workBin: join(import.meta.dir, "work.ts"),
			run: (argv) => {
				const cmd = argv[0].endsWith(".ts")
					? [process.execPath, ...argv]
					: argv;
				const r = Bun.spawnSync(cmd, {
					stdout: "pipe",
					stderr: "pipe",
					cwd: repo,
				});
				return { code: r.exitCode ?? 2, out: r.stdout.toString() };
			},
		};
		if (name === "smoke") return runSmoke(p, asJson);
		return emitRows(runChecks(ctx), asJson, repo);
	},
});
