#!/usr/bin/env bun
// probe-executor-lane.ts — W918.2 e2e executor-lane proof: ride the buckle
// lane front with a scoped key, complete a turn, then RESUME that session
// and prove the context carried. Evidence-backed capability states for the
// W918 catalog (parent): session-resumable + Buckle-route-compatible, per
// executor. The codex leg drives the REAL wrap machinery (packages/buckle
// bin/lane-wrap.ts → temp CODEX_HOME, env-key secret, wire_api="responses")
// — never a mirrored config render.
//
//   bun scripts/probe-executor-lane.ts codex [--front URL] [--model M]
//       [--slug S] [--wt DIR] [--key-file FILE] [--keep] [--timeout MS]
//
// Key source (config-over-code, never argv): --key-file (a 0600 lane-settings
// JSON whose env.ANTHROPIC_AUTH_TOKEN carries a bksk_ key) or the KLH_PROBE_KEY
// env var. The key is handed to the child only via the wrap's env_key name.
//
// Exit: 0 = both legs proven · 3 = executor/front precheck failed ·
//       4 = leg produced no verdict · 5 = resume mismatch.
import {
	existsSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const argv = process.argv.slice(2);
const arg = (name: string): string | undefined => {
	const i = argv.indexOf(`--${name}`);
	return i >= 0 ? argv[i + 1] : undefined;
};

const EXECUTOR = argv[0] ?? "codex";
const FRONT =
	arg("front") ??
	process.env.SUSPENDERS_BUCKLE_FRONT ??
	"http://127.0.0.1:4101";
const MODEL = arg("model") ?? "glm-5.3-flash";
const SLUG = arg("slug") ?? "executor-probe";
const TIMEOUT = Number(arg("timeout") ?? 240_000);
const KEEP = argv.includes("--keep");
const WT = resolveWt(arg("wt"));

function resolveWt(explicit: string | undefined): string {
	if (explicit) return explicit;
	const dir = mkdtempSync(join(tmpdir(), `executor-probe-`));
	return dir;
}

const keyFromFile = (file: string): string | null => {
	try {
		const parsed = JSON.parse(readFileSync(file, "utf8")) as {
			env?: Record<string, unknown>;
		};
		const v = parsed.env?.ANTHROPIC_AUTH_TOKEN;
		return typeof v === "string" && v.startsWith("bksk_") ? v : null;
	} catch {
		return null;
	}
};

const key =
	(arg("key-file") ? keyFromFile(arg("key-file") as string) : null) ??
	process.env.KLH_PROBE_KEY ??
	null;
if (!key) {
	console.error(
		"probe: no key — pass --key-file <0600 lane-settings json> or set KLH_PROBE_KEY",
	);
	process.exit(3);
}

const die = (code: number, why: string): never => {
	console.error(`probe: ${why}`);
	process.exit(code);
};

const frontUp = await fetch(`${FRONT}/status`, {
	signal: AbortSignal.timeout(1500),
})
	.then((r) => r.ok)
	.catch(() => false);
if (!frontUp) die(3, `buckle front ${FRONT} did not answer /status`);

const laneWrap = join(import.meta.dir, "../../buckle/bin/lane-wrap.ts");
const wrapPlan = Bun.spawnSync(
	[
		process.execPath,
		laneWrap,
		EXECUTOR,
		"--base-url",
		`${FRONT}/w/${SLUG}/v1`,
		"--model",
		MODEL,
	],
	{ stdout: "pipe", stderr: "pipe" },
);
const wrapOut = `${wrapPlan.stdout ? new TextDecoder().decode(wrapPlan.stdout) : ""}`;
const homeMatch = wrapOut.match(/export CODEX_HOME="([^"]+)"/);
if (wrapPlan.exitCode !== 0 || !homeMatch)
	die(
		3,
		`lane-wrap plan failed: ${wrapPlan.stderr ? new TextDecoder().decode(wrapPlan.stderr).trim() : wrapOut.trim()}`,
	);
const codexHome = homeMatch[1];

const cleanup = (): void => {
	if (!KEEP) rmSync(codexHome, { recursive: true, force: true });
	if (!arg("wt")) rmSync(WT, { recursive: true, force: true });
};
const childEnv: Record<string, string> = {};
for (const [k, v] of Object.entries(process.env))
	if (v !== undefined) childEnv[k] = v;
childEnv.CODEX_HOME = codexHome;
childEnv.LITELLM_KEY = key;

const TOKEN = `PROBE-${Math.random().toString(36).slice(2, 8).toUpperCase()}`;
const leg = (args: string[], lastFile: string) => {
	const p = Bun.spawnSync(
		[EXECUTOR, ...args, "--output-last-message", lastFile],
		{
			cwd: WT,
			env: childEnv,
			stdout: "pipe",
			stderr: "pipe",
			timeoutMs: TIMEOUT,
		},
	);
	return {
		code: p.exitCode ?? 1,
		out: p.stdout ? new TextDecoder().decode(p.stdout) : "",
		err: p.stderr ? new TextDecoder().decode(p.stderr) : "",
		reply: existsSync(lastFile) ? readFileSync(lastFile, "utf8").trim() : "",
	};
};

// Session id: the rollout file CODEX_HOME/sessions/<y>/<m>/<d>/rollout-<ts>-<uuid>.jsonl
const findSessionId = (): string | null => {
	const days = join(codexHome, "sessions");
	if (!existsSync(days)) return null;
	for (const y of readdirSync(days)) {
		for (const m of readdirSync(join(days, y))) {
			for (const d of readdirSync(join(days, y, m))) {
				const hit = readdirSync(join(days, y, m, d)).find((f) =>
					f.startsWith("rollout-"),
				);
				if (hit) return (hit.match(/([0-9a-f-]{36})\.jsonl$/) ?? [])[1] ?? null;
			}
		}
	}
	return null;
};

// Bounded stderr tails for the JSON evidence — the CLI's final diagnostics
// are the verdict; the early chatter is noise (lane-starter flattenTail shape).
const flattenTail = (s: string, cap = 300): string =>
	s.replaceAll(/\s+/g, " ").trim().slice(0, cap);

const started = Date.now();
const leg1 = leg(
	[
		"exec",
		"--json",
		"--skip-git-repo-check",
		"-C",
		WT,
		`Reply with exactly this token and nothing else: ${TOKEN}`,
	],
	join(WT, "leg1.txt"),
);
const leg1Ms = Date.now() - started;
const sessionId = findSessionId();
if (!sessionId) {
	cleanup();
	die(
		4,
		`leg 1 produced no session under ${codexHome}/sessions — err: ${leg1.err.slice(0, 300)}`,
	);
}

const started2 = Date.now();
const leg2 = leg(
	[
		"exec",
		"resume",
		sessionId,
		"--json",
		"--skip-git-repo-check",
		// no -C: the resume verb takes no --cd; the spawn cwd anchors the
		// session-cwd filter instead (verified live, codex-cli 0.158.0)
		`What exact token were you asked to reply with earlier in this session? Reply with the token alone, nothing else.`,
	],
	join(WT, "leg2.txt"),
);
const leg2Ms = Date.now() - started2;

const status = (await fetch(`${FRONT}/status`, {
	signal: AbortSignal.timeout(1500),
})
	.then((r) => r.json())
	.catch(() => null)) as {
	requests?: { by_route?: Record<string, number> };
} | null;
const routes = status?.requests?.by_route ?? {};
const frontLeg = Object.entries(routes).filter(([k]) =>
	k.startsWith(`/w/${SLUG}/`),
);

const resumed = leg2.reply.includes(TOKEN);
const verdict = resumed
	? `VERDICT: PASS`
	: `VERDICT: FAIL - resume reply did not carry the leg-1 token`;
console.log(
	JSON.stringify(
		{
			executor: EXECUTOR,
			front: FRONT,
			slug: SLUG,
			model: MODEL,
			leg1: {
				code: leg1.code,
				ms: leg1Ms,
				reply: leg1.reply.slice(0, 120),
				err: flattenTail(leg1.err),
			},
			leg2: {
				code: leg2.code,
				ms: leg2Ms,
				reply: leg2.reply.slice(0, 120),
				err: flattenTail(leg2.err),
			},
			session_id: sessionId,
			front_routes: frontLeg,
			resumed,
		},
		null,
		2,
	),
);
console.log(verdict);
cleanup();
process.exit(resumed ? 0 : 5);
