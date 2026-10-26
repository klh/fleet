#!/usr/bin/env bun
// hooks/bin/capacity-ramp.ts — W1713 operator-run, bounded capacity ramp for
// the buckle front: closed-loop virtual lanes (one scoped test key + one
// /w/<sid> identity each) send tiny tool-capable synthetic requests at stepped
// concurrency per route. The first provider429 / local503 / local429 stops the
// whole run; latency/error thresholds stop that route; own in-flight requests
// drain; every test key is revoked (and proven revoked) on exit.
//
//   capacity-ramp run --route [name=]model@messages|responses (repeatable)
//       [--live] [--steps 1,2,4] [--hold-s N] [--gap-ms N] [--max-requests N]
//       [--max-minutes N] [--max-p95-ms N] [--max-err-pct N] [--min-samples N]
//       [--tool-mode force|auto|none] [--max-out N] [--prefix-tokens N]
//       [--request-timeout-ms N] [--sample-ms N] [--drain-ms N]
//       [--front URL] [--out DIR]
//   capacity-ramp cleanup --manifest FILE [--front URL]
//
// Without --live, `run` only prints the bounded plan. Admin key: the sanctioned
// lane-auth channel (BUCKLE_ADMIN_KEY env, else belt.env). No gateway-wide
// drain, no reclaim/refill, no posture or config writes — it measures and reports.
import { mkdtempSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { buildConfig } from "../lib/capacity/ramp-config.ts";
import { fetchKeyRevocations } from "../lib/capacity/ramp-gateway.ts";
import { probeLiveLanes } from "../lib/capacity/ramp-lanes.ts";
import {
	cleanupManifest,
	readManifest,
} from "../lib/capacity/ramp-manifest.ts";
import type { RampConfig } from "../lib/capacity/ramp-run.ts";
import { runSession } from "../lib/capacity/ramp-session.ts";
import {
	BUCKLE_FRONT,
	adminKey,
	mintLaneKey,
	revokeLaneKey,
} from "../lib/lanes/lane-auth.ts";
import { defineVerb, runCli, type Parsed } from "../lib/verb-kit.ts";

const WORK_BIN =
	process.env.CAPACITY_RAMP_WORK_BIN ??
	join(homedir(), ".claude", "hooks", "suspenders", "bin", "work.ts");

const plan = (c: RampConfig, front: string): string =>
	[
		`capacity-ramp plan ${c.runId} front ${front}`,
		`routes: ${c.routes.map((r) => `${r.name}=${r.model}@${r.wire}`).join(", ")}`,
		`steps: ${c.steps.join(",")} each held ${String(c.holdS)}s, gap ${String(c.gapMs)}ms, tool-mode ${c.toolMode}, max-out ${String(c.maxOut)}`,
		`bounds: <=${String(c.maxRequests)} requests, <=${String(c.maxMinutes)} min, request timeout ${String(c.requestTimeoutMs)}ms, drain ${String(c.drainMs)}ms`,
		`stop: first provider429 / local503 / local429 (whole run); p95 > ${String(c.rules.maxP95Ms)}ms or errors > ${String(c.rules.maxErrPct)}% after ${String(c.rules.minSamples)} samples (that route)`,
		`lanes: ${c.lanePrefix}-NN (one scoped key each, revoked on exit)`,
	].join("\n");

const FLAGS = [
	"--route",
	"--steps",
	"--hold-s",
	"--gap-ms",
	"--max-requests",
	"--max-minutes",
	"--max-p95-ms",
	"--max-err-pct",
	"--min-samples",
	"--tool-mode",
	"--max-out",
	"--prefix-tokens",
	"--request-timeout-ms",
	"--sample-ms",
	"--drain-ms",
	"--front",
	"--out",
];

const RUN = defineVerb({
	name: "run",
	usage:
		"usage: capacity-ramp run --route [name=]model@messages|responses [--route ...] [--live] [--steps 1,2,4] [--hold-s N] [--gap-ms N] [--max-requests N] [--max-minutes N] [--max-p95-ms N] [--max-err-pct N] [--min-samples N] [--tool-mode force|auto|none] [--max-out N] [--prefix-tokens N] [--request-timeout-ms N] [--sample-ms N] [--drain-ms N] [--front URL] [--out DIR]",
	flags: FLAGS,
	switches: ["--live"],
	reqFlags: ["--route"],
	run: async (p: Parsed): Promise<number> => {
		const cfg = buildConfig(p, Date.now().toString(36));
		if (!cfg.ok) {
			console.error(`capacity-ramp: ${cfg.error}`);
			return 2;
		}
		const front = (p.flag("--front") ?? BUCKLE_FRONT).replace(/\/$/, "");
		console.log(plan(cfg.value, front));
		if (p.flag("--live") === null) {
			console.log("dry run — add --live to send traffic");
			return 0;
		}
		const admin = adminKey();
		if (admin === null) {
			console.error(
				"capacity-ramp: no admin key — cannot mint scoped test keys",
			);
			return 1;
		}
		const outDir =
			p.flag("--out") ?? mkdtempSync(join(tmpdir(), "capacity-ramp-"));
		const abort = new AbortController();
		for (const sig of ["SIGINT", "SIGTERM"] as const)
			process.once(sig, () => abort.abort());
		const out = await runSession(cfg.value, {
			fetch,
			front,
			admin,
			outDir,
			now: Date.now,
			sleep: (ms) => Bun.sleep(ms),
			mint: (sid) => mintLaneKey(sid, admin, fetch, front),
			revoke: (id) => revokeLaneKey(id, admin, fetch, front),
			liveLanes: () => probeLiveLanes(WORK_BIN),
			log: (line) => console.log(line),
			signal: abort.signal,
		});
		console.log(out.report);
		console.log(
			`revoke verified: ${String(out.revokeVerified)}; artifacts in ${outDir} (summary.json rows.ndjson manifest.json) — delete once reported`,
		);
		return out.result.stop?.reason === "mint_refused" ||
			out.revokeVerified === false
			? 1
			: 0;
	},
});

const CLEANUP = defineVerb({
	name: "cleanup",
	usage: "usage: capacity-ramp cleanup --manifest FILE [--front URL]",
	flags: ["--manifest", "--front"],
	reqFlags: ["--manifest"],
	run: async (p: Parsed): Promise<number> => {
		const m = readManifest(p.flag("--manifest") ?? "");
		if (m === null) {
			console.error("capacity-ramp: unreadable manifest");
			return 2;
		}
		const admin = adminKey();
		if (admin === null) {
			console.error("capacity-ramp: no admin key — cannot revoke");
			return 1;
		}
		const front = (p.flag("--front") ?? (m.front || BUCKLE_FRONT)).replace(
			/\/$/,
			"",
		);
		const r = await cleanupManifest(m, {
			revoke: (id) => revokeLaneKey(id, admin, fetch, front),
			revocations: (ids) => fetchKeyRevocations(fetch, front, admin, ids),
		});
		console.log(
			`cleanup: revoked ${String(r.revoked)}/${String(r.total)}, failed [${r.failed.join(",")}], gateway key list agrees: ${String(r.verified)}`,
		);
		return r.failed.length > 0 || r.verified === false ? 1 : 0;
	},
});

await runCli({
	prog: "capacity-ramp",
	about: "W1713 bounded capacity ramp.",
	verbs: [RUN, CLEANUP],
});
