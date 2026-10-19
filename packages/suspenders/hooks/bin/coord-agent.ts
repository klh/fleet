#!/usr/bin/env bun
// coord-agent.ts — W931 one-command owner bootstrap for the co-supervisor
// ingress: register an external agent (the ChatGPT co-supervisor, a codex
// relay) as a long-lived coord plane identity and print the exact connector
// config — board URL, write token path, the four routes. smoke runs the
// full loop (consult → reply → outbox) through the live wire.
//
// usage:
//   coord-agent enroll <sid> [--project dir] [--name label]
//   coord-agent smoke  <sid> [--project dir] [--base url]
import { readFileSync } from "node:fs";
import { writeTokenPath } from "../lib/host-guard.ts";
import { projectIdentity } from "../lib/govdb.ts";
import { defineVerb, runCli, type VerbSpec } from "../lib/verb-kit.ts";

const coordCli = new URL("coord.ts", import.meta.url).pathname;
const flag = (rest: string[], name: string): string | null => {
	const i = rest.indexOf(name);
	return i >= 0 ? (rest[i + 1] ?? null) : null;
};
const die = (m: string): never => {
	console.error(`coord-agent: ${m}`);
	process.exit(2);
};

function resolveTarget(rest: string[]): { sid: string; dir: string; project: string } {
	const sid = rest.find((a) => !a.startsWith("--"));
	if (!sid)
		die("usage: coord-agent enroll|smoke <sid> [--project dir] [--name label] [--base url]");
	const dir = flag(rest, "--project") ?? process.cwd();
	return { sid, dir, project: projectIdentity(dir) };
}

function enroll(rest: string[]): void {
	const { sid, dir, project } = resolveTarget(rest);
	const name = flag(rest, "--name") ?? sid;
	const p = Bun.spawnSync(
		[
			process.execPath,
			coordCli,
			"bootstrap",
			"--as",
			sid,
			"--role",
			"external",
			"--name",
			name,
		],
		{ cwd: dir, stdout: "pipe", stderr: "pipe" },
	);
	const out = `${p.stdout.toString()} ${p.stderr.toString()}`.trim();
	if (p.exitCode !== 0) die(`bootstrap failed: ${out}`);
	let tokenNote = "";
	try {
		tokenNote = readFileSync(writeTokenPath(), "utf8").trim()
			? "present"
			: "missing";
	} catch {
		tokenNote = "missing — start the board once (it mints the token)";
	}
	console.log(`✓ ${sid} enrolled on the coord plane (role external)`);
	console.log(`  project ${project}`);
	console.log("");
	console.log("Paste into the agent connector (config-over-code: values stay on this machine):");
	console.log(JSON.stringify(
		{
			base: `http://127.0.0.1:7799`,
			headers: {
				"x-klh-write-token": `<contents of ${writeTokenPath()} — ${tokenNote}>`,
			},
			project,
			sid,
			routes: {
				ask: "POST /api/consult {project, sid, q, target?|best?, scope?}",
				answer: "POST /api/consult-reply {project, sid, cid, answer|decline:true}",
				broadcast: "POST /api/broadcast {project, sid, note}",
				pull: `GET /api/outbox/${sid}?project=<project> (x-klh-write-token header)`,
			},
		},
		null,
		2,
	));
	console.log("");
	console.log(`Verify end to end: coord-agent smoke ${sid} --project ${dir}`);
}

async function smoke(rest: string[]): Promise<void> {
	const { sid, dir, project } = resolveTarget(rest);
	const base = flag(rest, "--base") ?? "http://127.0.0.1:7799";
	let token = "";
	try {
		token = readFileSync(writeTokenPath(), "utf8").trim();
	} catch {}
	if (!token) die(`no write token at ${writeTokenPath()} — start the board once`);
	const post = async (path: string, body: unknown): Promise<Record<string, unknown>> => {
		const r = await fetch(`${base}${path}`, {
			method: "POST",
			headers: {
				"content-type": "application/json",
				"x-klh-write-token": token,
			},
			body: JSON.stringify(body),
		});
		return r.json();
	};
	const fails: string[] = [];
	const q = `coord-agent smoke ${Date.now()}`;
	const ask = await post("/api/consult", { project, sid, q, target: sid });
	if (!ask.ok || ask.state !== "OPEN") fails.push(`consult: ${JSON.stringify(ask).slice(0, 200)}`);
	const cid = String(ask.consult ?? "");
	if (cid) {
		const reply = await post("/api/consult-reply", {
			project,
			sid,
			cid,
			answer: "coord-agent smoke reply",
		});
		if (reply.state !== "ANSWERED")
			fails.push(`consult-reply: ${JSON.stringify(reply).slice(0, 200)}`);
	}
	const pull = await (
		await fetch(`${base}/api/outbox/${sid}?project=${encodeURIComponent(project)}`, {
			headers: { "x-klh-write-token": token },
		})
	).json();
	if (!pull.ok) fails.push("outbox: not ok");
	if (fails.length) die(`SMOKE FAIL — ${fails.join("; ")}`);
	console.log(`SMOKE PASS ${cid} — consult, reply and outbox all served`);
}

const VERBS: VerbSpec[] = [
	defineVerb({
		name: "enroll",
		usage:
			"usage: coord-agent enroll <sid> [--project dir] [--name label] — register an external agent on the coord plane + print the connector config",
		lax: true,
		run: (p) => enroll(p.rest),
	}),
	defineVerb({
		name: "smoke",
		usage:
			"usage: coord-agent smoke <sid> [--project dir] [--base url] — consult → reply → outbox through the live HTTP wire",
		lax: true,
		run: (p) => smoke(p.rest),
	}),
];

await runCli({
	prog: "coord-agent",
	about: "coord-agent — external-agent identity bootstrap for the coord plane (W931).",
	verbs: VERBS,
	epilog: [
		"  enroll mints the session (role external); the board's /api/consult family",
		"  refreshes its heartbeat on every call. Auth stays the shared W264 write token.",
	].join("\n"),
});
