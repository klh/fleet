#!/usr/bin/env bun
// probe-claude-lane.ts — W929.1 e2e claude-executor lane proof: ride the
// buckle lane front with a scoped bksk_ key, complete a turn, then RESUME
// that session and prove the context carried. The claude overlay of
// probe-executor-lane.ts (codex): pure env reroute — the buckle claude
// recipe (buckle/src/agents.ts) has no ephemeral config home, so lane
// attribution is ANTHROPIC_BASE_URL = <front>/w/<slug> (anthropic root, NO
// /v1 — the client appends /v1/messages) + ANTHROPIC_AUTH_TOKEN; a fresh
// CLAUDE_CONFIG_DIR keeps the leg hermetic (verified live: headless -p has
// no onboarding wall). Spawn argv mirrors the claude adapter
// (hooks/lib/executors/claude.ts): flags, then -p; resume = --resume
// --fork-session.
//
//   bun scripts/probe-claude-lane.ts [--front URL] [--model M] [--slug S]
//       [--wt DIR] [--key-file FILE] [--keep] [--timeout MS]
//
// Key source (config-over-code, never argv): --key-file (a 0600
// lane-settings JSON whose env.ANTHROPIC_AUTH_TOKEN carries a bksk_ key) or
// the KLH_PROBE_KEY env var. Mint per run, revoke after (never left behind).
//
// Exit: 0 = both legs proven · 3 = executor/front precheck failed ·
//       4 = leg produced no verdict · 5 = resume mismatch.
import {
	chmodSync,
	existsSync,
	mkdtempSync,
	readFileSync,
	rmSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

const argv = process.argv.slice(2);
const arg = (name: string): string | undefined => {
	const i = argv.indexOf(`--${name}`);
	return i >= 0 ? argv[i + 1] : undefined;
};

const FRONT =
	arg("front") ??
	process.env.SUSPENDERS_BUCKLE_FRONT ??
	"http://127.0.0.1:4101";
const MODEL = arg("model") ?? "glm-5.3-flash";
const SLUG = arg("slug") ?? "claude-probe";
const TIMEOUT = Number(arg("timeout") ?? 240_000);
const KEEP = argv.includes("--keep");
const WT = arg("wt") ?? mkdtempSync(join(tmpdir(), "claude-probe-wt-"));
const BIN = Bun.which("claude") ?? join(homedir(), ".local/bin/claude");

const die = (code: number, why: string): never => {
	console.error(`probe: ${why}`);
	process.exit(code);
};

if (!existsSync(BIN)) die(3, `claude binary not found at ${BIN}`);
const frontUp = await fetch(`${FRONT}/status`, {
	signal: AbortSignal.timeout(1500),
})
	.then((r) => r.ok)
	.catch(() => false);
if (!frontUp) die(3, `buckle front ${FRONT} did not answer /status`);

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

const cfgHome = mkdtempSync(join(tmpdir(), "claude-probe-home."));
chmodSync(cfgHome, 0o700);
const childEnv: Record<string, string> = {};
for (const [k, v] of Object.entries(process.env))
	if (v !== undefined) childEnv[k] = v;
childEnv.CLAUDE_CONFIG_DIR = cfgHome;
// anthropic root: NO /v1 — the claude CLI appends /v1/messages
childEnv.ANTHROPIC_BASE_URL = `${FRONT}/w/${SLUG}`;
childEnv.ANTHROPIC_AUTH_TOKEN = key;

const cleanup = (): void => {
	if (!KEEP) rmSync(cfgHome, { recursive: true, force: true });
	if (!arg("wt")) rmSync(WT, { recursive: true, force: true });
};

// claude -p --output-format json prints ONE result object on stdout; the
// codex probe's --output-last-message file doesn't exist on this harness.
const claudeJsonOf = (
	stdout: string,
): { reply: string; sid: string | null } => {
	try {
		const j = JSON.parse(stdout) as { result?: unknown; session_id?: unknown };
		return {
			reply: typeof j.result === "string" ? j.result.trim() : "",
			sid: typeof j.session_id === "string" ? j.session_id : null,
		};
	} catch {
		return { reply: "", sid: null };
	}
};

// adapter argv shape (hooks/lib/executors/claude.ts): flags first, -p last
const leg = (extra: string[], prompt: string) => {
	const p = Bun.spawnSync(
		[
			BIN,
			"--model",
			MODEL,
			"--output-format",
			"json",
			"--permission-mode",
			"acceptEdits",
			...extra,
			"-p",
			prompt,
		],
		{
			cwd: WT,
			env: childEnv,
			stdout: "pipe",
			stderr: "pipe",
			timeoutMs: TIMEOUT,
		},
	);
	const stdout = p.stdout ? new TextDecoder().decode(p.stdout) : "";
	return {
		code: p.exitCode ?? 1,
		out: stdout,
		err: p.stderr ? new TextDecoder().decode(p.stderr) : "",
		...claudeJsonOf(stdout),
	};
};

const TOKEN = `PROBE-${Math.random().toString(36).slice(2, 8).toUpperCase()}`;
const flattenTail = (s: string, cap = 300): string =>
	s.replaceAll(/\s+/g, " ").trim().slice(0, cap);

const started = Date.now();
const leg1 = leg(
	[],
	`Reply with exactly this token and nothing else: ${TOKEN}`,
);
const leg1Ms = Date.now() - started;
const sessionId = leg1.sid;
if (!sessionId) {
	cleanup();
	die(4, `leg 1 produced no session_id — err: ${leg1.err.slice(0, 300)}`);
}

// resume leg: the adapter's forkArgs — --resume <sid> --fork-session; the
// fresh CLAUDE_CONFIG_DIR holds the session store, so resume resolves there
const started2 = Date.now();
const leg2 = leg(
	["--resume", sessionId, "--fork-session"],
	`What exact token were you asked to reply with earlier in this session? Reply with the token alone, nothing else.`,
);
const leg2Ms = Date.now() - started2;
const resumed = leg2.reply.includes(TOKEN);

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
const verdict = resumed
	? "VERDICT: PASS"
	: "VERDICT: FAIL - resume reply did not carry the leg-1 token";
console.log(
	JSON.stringify({
		executor: "claude",
		front: FRONT,
		slug: SLUG,
		model: MODEL,
		session_id: sessionId,
		front_routes: frontLeg,
		resumed,
	}),
);
console.log(
	JSON.stringify({
		leg1: {
			code: leg1.code,
			ms: leg1Ms,
			reply: leg1.reply.slice(0, 120),
			err: flattenTail(leg1.err),
		},
	}),
);
console.log(
	JSON.stringify({
		leg2: {
			code: leg2.code,
			ms: leg2Ms,
			reply: leg2.reply.slice(0, 120),
			err: flattenTail(leg2.err),
		},
	}),
);
console.log(verdict);
cleanup();
process.exit(resumed ? 0 : 5);
