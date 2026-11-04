#!/usr/bin/env bun
// hooks/bin/lost-hub.ts — W2321.4 CLI face of the lost-hub requeue policy
// (hooks/lib/fleet-loop/lost-hub.ts). For every live hub profile: probe the
// hub's published health face over ssh (or local docker shape), classify the
// episode (first-loss-anchored grace, 15-min default — the MultiKueue
// workerLostTimeout analog), and past grace requeue the hub's CLAIMED items
// → READY, budgeted, through the ONE release path. Dry-run by default;
// --act releases. Exit 1 when any hub sits lost (grace or past) — a human
// should notice — else 0.
//
//   bun hooks/bin/lost-hub.ts [--act] [--json] [--hub <name>] [--grace-ms <n>]
//
// Probe doctrine (health-is-outside-process + lesson.hub-reboot-needs-
// compose-up): the OUTSIDE view of a published health face, never the served
// process. An unprobeable hub (ssh itself fails to run) is NO observation —
// W51 lookup failure is never loss; the anchored clock keeps but no release
// fires without a positive loss verdict.
import { join } from "node:path";
import { broadcastNote } from "../coord/bus.ts";
import { emitLoopEvent } from "../lib/fleet-loop/events.ts";
import { realHubExec } from "../lib/fleet-loop/hub-port-heal.ts";
import {
	classifyLostHub,
	classifyProbeRun,
	hubClaims,
	lostHubPaused,
	readEpisode,
	resolveLostHubGraceMs,
	requeueHubClaims,
	sshHostPart,
	toLostHubTarget,
	healthProbeScript,
	writeEpisode,
	type LostHubEpisode,
} from "../lib/fleet-loop/lost-hub.ts";
import { loadStack, inQuietHours } from "../lib/stack-config.ts";
import { openStore, projectIdentity } from "../lib/govdb/govdb.ts";
import { defineVerb, parseVerb, renderVerbHelp } from "../lib/verb-kit.ts";

async function main(argv: string[]): Promise<number> {
	const SPEC = defineVerb({
		name: "lost-hub",
		usage:
			"usage: bun lost-hub.ts [--act] [--json] [--hub <name>] — dry-run default",
		flags: ["--hub", "--grace-ms"],
		switches: ["--act", "--json"],
	});
	if (argv.includes("--help") || argv.includes("-h")) {
		console.log(renderVerbHelp(SPEC));
		return 0;
	}
	const parsed = parseVerb(SPEC, argv);
	if (!parsed.ok || !parsed.parsed) {
		console.error(parsed.message ?? SPEC.usage);
		return 2;
	}
	const act = parsed.parsed.flag("--act") === "true";
	const json = parsed.parsed.flag("--json") === "true";
	const only = parsed.parsed.flag("--hub");
	const graceOverride = parsed.parsed.flag("--grace-ms");

	const stack = loadStack();
	const hubs = new Map(
		Object.entries(stack.hubs)
			.filter(([, h]) => h.deploy?.ssh)
			.map(([label, h]) => [label, sshHostPart(h.deploy?.ssh ?? "")]),
	);
	const store = openStore();
	const repo = process.env.SUSPENDERS_REPO ?? join(import.meta.dir, "../../..");
	const project = projectIdentity(repo);
	// B2 (W2510 review): the override rides the library sanitizer — a bare
	// Number() turns NaN into zero-grace requeue and lets "0" bypass the
	// 60s floor, releasing a hub's CLAIMED items on the FIRST dark probe.
	const graceMs = resolveLostHubGraceMs(graceOverride);
	const exec = realHubExec(15_000);
	const reports: Record<string, unknown>[] = [];
	let anyLost = false;

	for (const [name, hub] of Object.entries(stack.hubs)) {
		if (only && name !== only) continue;
		const target = toLostHubTarget(name, hub);
		if (!target) continue;
		// expected-dark hubs are healthy-by-policy: skip, never probe into a
		// nightly poweroff (W483 posture, hub-port-heal parity)
		if (inQuietHours(hub)) {
			reports.push({ hub: name, verdict: "quiet-hours", act });
			continue;
		}
		const run = exec(target, healthProbeScript(target.healthPort));
		const seen = classifyProbeRun(run.code);
		if (seen === "none") {
			// local spawn failure — the probe never ran: NO observation (W51),
			// the anchored clock keeps, nothing releases on absent evidence
			reports.push({
				hub: name,
				verdict: "unprobeable",
				detail: String(run.out).trim().slice(0, 200),
			});
			continue;
		}
		// transport refusal IS the disconnect observation (MultiKueue
		// connectionState): a dark hub host accrues loss toward the grace
		const reachable = seen === "reachable" && run.out.trim() === "200";
		let prev: LostHubEpisode;
		try {
			prev = readEpisode(store, project, name);
		} catch (e) {
			// N2 (W2510 review): a corrupt facts row must NOT fabricate an
			// empty episode (that re-anchors the grace clock every pass);
			// surface it and skip classification for this hub entirely.
			reports.push({
				hub: name,
				verdict: "episode-corrupt",
				detail: String(e).slice(0, 200),
			});
			anyLost = true; // a human should notice, same contract as a lost hub
			continue;
		}
		const verdict = classifyLostHub(
			prev,
			{ hub: name, reachable, now: Date.now() },
			graceMs,
		);
		writeEpisode(store, project, name, verdict.episode);
		if (verdict.action !== "ok") anyLost = true;
		// N1 (W2510 review): the notify-once-per-episode contract — classify
		// flags the FIRST loss observation of an episode (grace start), the
		// FIRST grace lapse, and the recovery transition; consume it here or
		// the field is dead plumbing.
		if (verdict.notify) {
			const detail =
				verdict.action === "ok"
					? `recovered — episode closed after ${prev.firstLostAt !== undefined ? Math.round((Date.now() - prev.firstLostAt) / 1000) : 0}s`
					: verdict.action === "grace"
						? `first loss observed — grace ${Math.round(graceMs / 1000)}s anchor set; claims hold until it lapses`
						: "grace lapsed — requeue pass begins (budgeted)";
			broadcastNote(
				`[lost-hub] ${name} ${verdict.action === "ok" ? "RECOVERED" : "LOST"} — ${detail}`,
				"lost-hub-sweep",
			);
			emitLoopEvent("plane.lost-hub", name, {
				project,
				hub: name,
				kind: "lost-hub",
				transition:
					verdict.action === "ok"
						? "recovered"
						: verdict.action === "grace"
							? "first-loss"
							: "grace-lapsed",
			});
		}
		let outcomes: unknown[] = [];
		if (verdict.action === "requeue") {
			const claims = hubClaims(store, project, repo, name, hubs);
			if (act && !lostHubPaused(repo)) {
				outcomes = requeueHubClaims(store, {
					project,
					repo,
					hub: name,
					claims,
					emitDecision: (id, note) => {
						emitLoopEvent("NEED_DECISION", id, {
							project,
							hub: name,
							reason: note,
						});
					},
				});
				// N1: the requeue transition fired — stamp the episode so the
				// notify contract is once per EPISODE, not once per 5-min pass
				writeEpisode(store, project, name, {
					...verdict.episode,
					requeued: true,
				});
				const released = (outcomes as { action: string }[]).filter(
					(o) => o.action === "released",
				);
				if (released.length)
					broadcastNote(
						`[lost-hub] ${name} lost past grace — requeued ${released.map((r) => ("id" in r ? r.id : "")).join(",")} → READY (budgeted; lane may still run hub-side)`,
						"lost-hub-sweep",
					);
			} else {
				outcomes = claims.map((c) => ({
					id: c.id,
					action: "dry-run",
					why: "hub lost past grace — would requeue (budgeted)",
				}));
			}
		}
		reports.push({
			hub: name,
			verdict: verdict.action,
			firstLostAt: verdict.episode.firstLostAt,
			graceMs: graceMs ?? "default",
			claims: outcomes,
			act,
		});
	}
	if (json) console.log(JSON.stringify({ act, reports }, null, 2));
	else
		for (const r of reports) {
			const claims = Array.isArray(r.claims) ? r.claims : [];
			console.log(
				`${r.hub}: ${r.verdict}${claims.length ? ` — ${claims.length} claim(s)` : ""}`,
			);
		}
	return anyLost ? 1 : 0;
}

if (import.meta.main) {
	process.exit(await main(process.argv.slice(2)));
}
