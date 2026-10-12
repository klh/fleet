#!/usr/bin/env bun
// deploy/e2e/run-e2e.ts — the W234 docker e2e runner: stands the full chain
// up (e2e-compose.yaml), waits for outside-process health, then walks the
// mission probes against the LIVE containers:
//   1. admin key lifecycle   — mint (root → bksk_ admin), use, revoke, 401
//   2. chat through buckle   — anthropic + openai dialects, direct + caddy
//   3. enroll a hub          — enrollment code → spoke token → fed pull
//   4. dispatch a lane       — real dispatch-next.ts pins the lane to the
//                              compose hub; the stub executor routes one
//                              chat through <hub>/w/<sid> and writes evidence
// Exit code gates CI. Usage:
//   FLEET_DIR=<checkout> bun run-e2e.ts [--keep] [--overlay] [--skip-dispatch]
// Teardown (compose down -v, lane reap) runs even on failure unless --keep.

import { spawn, spawnSync } from "node:child_process";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { laneSid } from "../../hooks/lib/laneslug.ts";
import { projectIdentity } from "../../hooks/lib/govdb.ts";

const DIR = import.meta.dir;
const FLEET_DIR = process.env.FLEET_DIR ?? join(DIR, "../../..");
const COMPOSE_FILE = join(DIR, "e2e-compose.yaml");
const BUCKLE = "http://127.0.0.1:4111";
const BELT_STUB = "http://127.0.0.1:8902";
const CADDY = "http://127.0.0.1:8080";
const BOARD = "http://127.0.0.1:7809";
const MARKER = "e2e-stub-ok";
const ROOT_KEY_FILE = join(DIR, "buckle.env");

interface ProbeResult {
	name: string;
	ok: boolean;
	detail: string;
}

// ---- compose plumbing ----------------------------------------------------

function compose(args: string[], extraProfile: boolean): string {
	const cmd = ["compose", "-f", COMPOSE_FILE];
	if (extraProfile) cmd.push("--profile", "overlay");
	cmd.push(...args);
	const p = spawnSync("docker", cmd, {
		cwd: DIR,
		env: { ...process.env, FLEET_DIR },
		encoding: "utf8",
	});
	if (p.status !== 0) {
		throw new Error(
			`docker compose ${args.join(" ")} failed (${p.status}): ${p.stderr.trim()}`,
		);
	}
	return p.stdout;
}

/** Mint the buckle root key ON this device, 0600, idempotent — the same
 *  contract hubctl's MINT_SCRIPT enforces on hub deploys. */
export function mintRootKey(path: string): string {
	if (existsSync(path)) {
		const line = readFileSync(path, "utf8").trim();
		if (line.length > 0) return line.split("=")[1] ?? "";
	}
	const key = randomBytes(32).toString("hex");
	writeFileSync(path, `BUCKLE_ROOT_KEY=${key}\n`, { mode: 0o600 });
	chmodSync(path, 0o600);
	return key;
}

async function waitHealthy(
	name: string,
	url: string,
	timeoutMs: number,
): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		try {
			const res = await fetch(url, { signal: AbortSignal.timeout(3000) });
			if (res.ok) return;
		} catch {
			// not up yet — retry until the deadline
		}
		await Bun.sleep(2000);
	}
	throw new Error(`${name} never went healthy: ${url}`);
}

// ---- buckle probes -------------------------------------------------------

async function mintKey(
	admin: string,
	name: string,
	scopes: string[],
): Promise<{ key: string; keyId: string }> {
	const res = await fetch(`${BUCKLE}/v1/admin/keys`, {
		method: "POST",
		headers: { authorization: `Bearer ${admin}` },
		body: JSON.stringify({ name, scopes }),
	});
	if (res.status !== 201) {
		throw new Error(`mint ${name}: ${res.status} ${await res.text()}`);
	}
	const body = (await res.json()) as { key: string; key_id: string };
	return { key: body.key, keyId: body.key_id };
}

async function chat(
	base: string,
	token: string,
	dialect: "anthropic" | "openai",
): Promise<{ status: number; sample: string }> {
	const path =
		dialect === "anthropic" ? "/v1/messages" : "/v1/chat/completions";
	const body =
		dialect === "anthropic"
			? {
					model: "glm-5.3-flash",
					max_tokens: 16,
					stream: false,
					messages: [
						{ role: "user", content: "Reply with the single word: ok" },
					],
				}
			: {
					model: "local-swarm",
					stream: false,
					messages: [
						{ role: "user", content: "Reply with the single word: ok" },
					],
				};
	const res = await fetch(`${base}${path}`, {
		method: "POST",
		headers: {
			"content-type": "application/json",
			authorization: `Bearer ${token}`,
		},
		body: JSON.stringify(body),
		signal: AbortSignal.timeout(30000),
	});
	const text = await res.text();
	const m = /"(?:text|content)":"([^"]*)"/.exec(text);
	return { status: res.status, sample: m?.[1] ?? text.slice(0, 120) };
}

/** Probe 1: mint an admin key with the root credential, use a proxy-scoped
 *  key, revoke it, and prove the gate closes behind the revocation. */
async function probeAdminLifecycle(root: string): Promise<ProbeResult> {
	const admin = await mintKey(root, "e2e-admin", [
		"buckle:admin:WRITE_",
		"buckle:proxy:WRITE_",
	]);
	const scoped = await mintKey(admin.key, "e2e-scoped", [
		"buckle:proxy:WRITE_",
	]);
	const used = await chat(BUCKLE, scoped.key, "openai");
	if (used.status !== 200 || !used.sample.includes(MARKER)) {
		return {
			name: "admin-token-lifecycle",
			ok: false,
			detail: `scoped key chat → ${used.status} "${used.sample}"`,
		};
	}
	const revoke = await fetch(`${BUCKLE}/v1/admin/keys/${scoped.keyId}/revoke`, {
		method: "POST",
		headers: { authorization: `Bearer ${admin.key}` },
	});
	const after = await chat(BUCKLE, scoped.key, "openai");
	const ok = revoke.status === 200 && after.status === 401;
	return {
		name: "admin-token-lifecycle",
		ok,
		detail: `mint→use ${used.status}, revoke ${revoke.status}, post-revoke ${after.status} (want 401)`,
	};
}

/** Probe 2: route real chats through the gate — anthropic dialect direct,
 *  openai dialect through the caddy front — both answered by the stub tier. */
async function probeChatThroughBuckle(root: string): Promise<ProbeResult> {
	const viaGate = await chat(BUCKLE, root, "anthropic");
	const viaCaddy = await chat(CADDY, root, "openai");
	const ok =
		viaGate.status === 200 &&
		viaGate.sample.includes(MARKER) &&
		viaCaddy.status === 200 &&
		viaCaddy.sample.includes(MARKER);
	return {
		name: "chat-through-buckle",
		ok,
		detail: `gate /v1/messages → ${viaGate.status} "${viaGate.sample}", caddy /v1/chat/completions → ${viaCaddy.status} "${viaCaddy.sample}"`,
	};
}

/** Probe 3: enroll a hub — admin mints a one-time code, the spoke redeems
 *  it for a hub-issued token, the token pulls the policy manifest. */
async function probeEnrollHub(admin: string): Promise<ProbeResult> {
	const mintRes = await fetch(`${BUCKLE}/v1/admin/spokes/enroll`, {
		method: "POST",
		headers: { authorization: `Bearer ${admin}` },
		body: JSON.stringify({ spoke_id: "e2e-hub" }),
	});
	if (mintRes.status !== 201) {
		return {
			name: "enroll-a-hub",
			ok: false,
			detail: `enroll code mint → ${mintRes.status} ${await mintRes.text()}`,
		};
	}
	const { code } = (await mintRes.json()) as { code: string };
	const redeem = await fetch(`${BUCKLE}/federation/enroll`, {
		method: "POST",
		body: JSON.stringify({ code }),
	});
	const out = (await redeem.json()) as { key?: string };
	if (redeem.status !== 201 || !out.key) {
		return {
			name: "enroll-a-hub",
			ok: false,
			detail: `redeem → ${redeem.status} ${JSON.stringify(out).slice(0, 120)}`,
		};
	}
	const pull = await fetch(`${BUCKLE}/federation/policy-manifest`, {
		headers: {
			authorization: `Bearer ${out.key}`,
			"x-buckle-spoke-version": "e2e@w234",
		},
	});
	const manifestOk = pull.status === 200;
	let version = "";
	if (manifestOk) {
		version = ((await pull.json()) as { version?: string }).version ?? "";
	}
	return {
		name: "enroll-a-hub",
		ok: manifestOk,
		detail: `code→redeem ${redeem.status}, spoke pull ${pull.status} (manifest ${version || "none"})`,
	};
}

// ---- dispatch probe ------------------------------------------------------

/** Probe 4: dispatch a REAL lane at the compose hub via dispatch-next.ts in
 *  a scratch repo; the stub executor routes one chat through <hub>/w/<sid>.
 *  Reuses the dispatch-hub-e2e fixture shape (W357) against live containers. */
async function probeDispatchLane(
	adminKey: string,
	timeoutMs: number,
): Promise<ProbeResult> {
	const home = mkdtempSync(join(tmpdir(), "w234-e2e-home-"));
	const repo = mkdtempSync(join(tmpdir(), "w234-e2e-repo-"));
	const bin = join(FLEET_DIR, "packages", "suspenders", "hooks", "bin");
	const evidencePath = join(home, "lane-evidence.json");
	const executor = join(home, "w234-executor");
	writeFileSync(
		executor,
		`#!/bin/sh\nexec bun ${join(DIR, "lane-executor.ts")}\n`,
		{ mode: 0o700 },
	);
	const beltEnv = join(home, "belt.env");
	writeFileSync(beltEnv, `BUCKLE_ADMIN_KEY=${adminKey}\n`);
	const hubsFile = join(home, "hubs.json");
	writeFileSync(
		hubsFile,
		JSON.stringify({
			"e2e-hub": {
				candidates: [BUCKLE],
				token: adminKey,
			},
		}),
	);
	mkdirSync(join(home, ".claude", "hooks", "suspenders"), { recursive: true });
	symlinkSync(bin, join(home, ".claude", "hooks", "suspenders", "bin"), "dir");
	const g = (args: string[]): void => {
		const p = spawnSync("/usr/bin/git", args, {
			cwd: repo,
			encoding: "utf8",
		});
		if (p.status !== 0)
			throw new Error(`git ${args.join(" ")} failed: ${p.stderr}`);
	};
	g(["init", "-b", "main"]);
	g(["config", "user.email", "e2e@threads.dk"]);
	g(["config", "user.name", "e2e"]);
	writeFileSync(join(repo, "README.md"), "w234 dispatch e2e");
	g(["add", "-A"]);
	g(["commit", "-m", "base"]);
	writeFileSync(join(repo, ".prefer"), "hub=e2e-hub\n");

	const env = {
		...process.env,
		HOME: home,
		SUSPENDERS_CLAUDE_BIN: executor,
		SUSPENDERS_BELT_ENV: beltEnv,
		SUSPENDERS_HUBS_FILE: hubsFile,
		SUSPENDERS_BUCKLE_FRONT: "http://127.0.0.1:1",
		KLH_LANE_EVIDENCE: evidencePath,
		// the runner's own session env must never leak into the lane pin
		ANTHROPIC_BASE_URL: undefined,
		ANTHROPIC_AUTH_TOKEN: undefined,
		ANTHROPIC_API_KEY: undefined,
	};
	const add = spawnSync(
		process.execPath,
		[join(bin, "work.ts"), "add", "w234 dispatch e2e"],
		{ cwd: repo, env, encoding: "utf8" },
	);
	const id = (/W\d+/.exec(add.stdout) ?? [])[0];
	if (!id) {
		return {
			name: "dispatch-a-lane",
			ok: false,
			detail: `work add failed: ${add.stdout} ${add.stderr}`,
		};
	}
	const p = spawn(
		process.execPath,
		[
			join(FLEET_DIR, "packages", "suspenders", "scripts", "dispatch-next.ts"),
			"--repo",
			repo,
			"--item",
			id,
		],
		{ cwd: repo, env, stdout: "pipe", stderr: "pipe" },
	);
	const sid = laneSid(id, projectIdentity(repo));
	const deadline = Date.now() + timeoutMs;
	let evidence: Evidence | null = null;
	while (Date.now() < deadline) {
		if (existsSync(evidencePath)) {
			evidence = JSON.parse(readFileSync(evidencePath, "utf8")) as Evidence;
			break;
		}
		// the dispatch may die instantly (module resolution, bad args) —
		// break so the streams are drained BEFORE the buffered stdio is lost
		if (p.exitCode !== null || p.signalCode !== null) break;
		await Bun.sleep(1000);
	}
	// reap: never leave a lane behind
	if (evidence) {
		try {
			process.kill(evidence.pid);
		} catch {
			// already gone
		}
	}
	p.kill();
	const out = await new Response(p.stdout).text();
	const err = await new Response(p.stderr).text();
	rmSync(home, { recursive: true, force: true });
	rmSync(repo, { recursive: true, force: true });
	if (evidence === null) {
		return {
			name: "dispatch-a-lane",
			ok: false,
			detail: `no lane evidence in ${timeoutMs / 1000}s — dispatch out: ${(out + err).slice(0, 200)}`,
		};
	}
	const wantBase = `${BUCKLE}/w/${sid}`;
	const ok =
		evidence.ok &&
		evidence.status === 200 &&
		evidence.base === wantBase &&
		evidence.sample.includes(MARKER);
	return {
		name: "dispatch-a-lane",
		ok,
		detail: `sid=${sid} base=${evidence.base} (want ${wantBase}) status=${evidence.status} sample="${evidence.sample}"`,
	};
}

interface Evidence {
	pid: number;
	ok: boolean;
	status: number;
	base: string;
	sample: string;
}

// teardown state: the fatal path must tear down what was actually started
let overlayOn = false;

// ---- main ----------------------------------------------------------------

async function main(): Promise<void> {
	const flags = new Set(process.argv.slice(2));
	const keep = flags.has("--keep");
	const overlay = flags.has("--overlay");
	overlayOn = overlay;
	const skipDispatch = flags.has("--skip-dispatch");
	const timeoutS = Number(
		process.env.KLH_E2E_TIMEOUT_S ?? (process.env.CI ? "420" : "240"),
	);

	const root = mintRootKey(ROOT_KEY_FILE);
	console.log(`[W234·e2e] root key ${ROOT_KEY_FILE} (0600, idempotent)`);
	console.log(
		`[W234·e2e] compose up (FLEET_DIR=${FLEET_DIR}${overlay ? ", +overlay" : ""})`,
	);
	compose(["up", "-d", "--wait"], overlay);
	await waitHealthy("belt-stub", `${BELT_STUB}/healthz`, timeoutS * 1000);
	await waitHealthy("buckle", `${BUCKLE}/status`, timeoutS * 1000);
	await waitHealthy("caddy", `${CADDY}/status`, timeoutS * 1000);
	await waitHealthy("board", `${BOARD}/status`, timeoutS * 1000);
	// the store is loopback-only (W92) — no host probe can reach it through
	// a published port; its verdict rides the shared-netns store-health
	// sidecar, enforced by compose up --wait
	if (overlay)
		await waitHealthy(
			"buckle-overlay",
			"http://127.0.0.1:4121/status",
			timeoutS * 1000,
		);
	console.log("[W234·e2e] chain healthy");

	const admin = await mintKey(root, "e2e-admin-runner", [
		"buckle:admin:WRITE_",
		"buckle:proxy:WRITE_",
	]);
	const results: ProbeResult[] = [];
	results.push(await probeChatThroughBuckle(root));
	results.push(await probeAdminLifecycle(root));
	results.push(await probeEnrollHub(admin.key));
	if (skipDispatch) {
		console.log("[W234·e2e] dispatch probe skipped (--skip-dispatch)");
	} else {
		results.push(
			await probeDispatchLane(admin.key, Math.max(60, timeoutS / 2) * 1000),
		);
	}
	for (const r of results) {
		console.log(`[W234·e2e] ${r.ok ? "✓" : "✗"} ${r.name} — ${r.detail}`);
	}
	const failed = results.filter((r) => !r.ok).length;
	if (!keep) {
		compose(["down", "-v", "--remove-orphans"], overlay);
		console.log("[W234·e2e] compose down -v (teardown)");
	} else {
		console.log(
			"[W234·e2e] --keep: stack left running (buckle :4111, caddy :8080)",
		);
	}
	if (failed > 0) {
		console.log(`E2E FAIL ${failed}/${results.length} probes failed`);
		process.exit(1);
	}
	console.log(`E2E PASS ${results.length}/${results.length} probes`);
}

if (import.meta.main) {
	main().catch((err) => {
		console.error(`[W234·e2e] FATAL ${String(err)}`);
		try {
			// evidence before teardown: health states + container logs name
			// the boot failure
			console.log(compose(["ps", "-a"], overlayOn));
			console.log(compose(["logs", "--tail", "40"], overlayOn));
		} catch (logErr) {
			console.error(`[W234·e2e] (no logs: ${String(logErr)})`);
		}
		try {
			compose(["down", "-v", "--remove-orphans"], overlayOn);
		} catch {
			// teardown best-effort on failure paths
		}
		process.exit(1);
	});
}
