// sim/ikea-pilot.ts — W539 IKEA health-policy pilot: the reproducible
// evidence run (line-per-check, smoke.ts style). Boots an isolated org-hub
// buckle front on loopback serving the pilot health-policy rows (the exact
// IKEA question + org scope), runs two developer clones' managed sessions
// against it, proves concurrent approvals mint exactly one remediation
// item, verifies per-instance reporters, and runs the bounded negative
// legs. Everything binds loopback and lives under a pilot root — no shared
// container churn, no production experiments.
//
// usage: bun sim/ikea-pilot.ts [--keep]
//   default root /tmp/ikea-pilot; --keep preserves it for inspection.

import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { startServer } from "../../buckle/src/server.ts";

interface Check {
	leg: string;
	ok: boolean;
	detail: string;
}

const checks: Check[] = [];
function record(leg: string, ok: boolean, detail: string): void {
	checks.push({ leg, ok, detail });
	console.log(`${ok ? "PASS" : "RED "} ${leg}  ${detail}`);
}

const ROOT = "/tmp/ikea-pilot";
const WT = import.meta.dir + "/../../.."; // packages/suspenders/sim → fleet root

function script(name: string): string {
	return join(WT, "packages", "suspenders", "hooks", "bin", name);
}

const dec = new TextDecoder();
function run(
	cmd: string[],
	env: Record<string, string>,
	cwd?: string,
): { code: number; out: string } {
	const r = Bun.spawnSync(cmd, {
		cwd: cwd ?? ROOT,
		env,
		stdout: "pipe",
		stderr: "pipe",
	});
	return {
		code: r.exitCode ?? 1,
		out: dec.decode(r.stdout) + dec.decode(r.stderr),
	};
}

async function main(): Promise<void> {
	// --keep
	const keep = process.argv.includes("--keep");
	if (!keep) rmSync(ROOT, { recursive: true, force: true });
	mkdirSync(ROOT, { recursive: true });
	buildWorld();
	const hub = await orgHubLegs();
	try {
		await sessionLegs();
		await authorizeLeg();
		await assessLeg();
		await reporterLegs();
		await negativeLegs();
	} finally {
		hub.stop(true);
	}
	const failed = checks.filter((c) => !c.ok);
	console.log(
		`\n${checks.length - failed.length}/${checks.length} checks pass — ${failed.length === 0 ? "pilot GREEN" : "pilot has RED legs (recorded honestly)"}`,
	);
	// explicit exit (smoke.ts precedent): a lingering handle — the nohup'd
	// subscribe grandchildren hold no FD here, but Bun's loop may outlive
	// the work — must not keep the pilot alive past its verdict
	process.exit(failed.length > 0 ? 2 : 0);
}

/** The pilot world: policy yaml (the exact IKEA question + org scope),
 *  two developer clones of one service repo, one of them dirty. */
function buildWorld(): void {
	mkdirSync(join(ROOT, "secrets"), { recursive: true });
	// the org's health policy row — the exact requested question, scoped to
	// the service identity the org assigns (never a checkout path)
	writeFileSync(
		join(ROOT, "pilot-policy.yaml"),
		`version: 1
rows:
  - id: corp-health-endpoints
    repoClass: api
    detect:
      - existsAny: [server.ts, src/server.ts]
    check:
      - grepAny: [server.ts, src/server.ts]
        pattern: "/health|/status"
    missingQuestion: "This repo does not seem to have health and status endpoints. According to IKEA policy it should. Do you want me to implement them for you?"
    policySource: "operator:ikea-health-v1"
    serviceId: orders-api
    policyId: corp.api.independent-health
    orgId: org-pilot
`,
	);
	// the service repo: an API with no health endpoint (the gap)
	mkdirSync(join(ROOT, "orders-api-alice"), { recursive: true });
	writeFileSync(
		join(ROOT, "orders-api-alice/server.ts"),
		"Bun.serve({fetch:()=>new Response('orders')});\n",
	);
	gitInit();
	// two independent developer clones of the SAME service repo
	runBun([
		"git",
		"clone",
		"--quiet",
		join(ROOT, "orders-api-alice"),
		join(ROOT, "orders-api-bob"),
	]);
}

function gitInit(): void {
	runBun(["git", "-C", join(ROOT, "orders-api-alice"), "init", "--quiet"]);
	runBun(["git", "-C", join(ROOT, "orders-api-alice"), "add", "-A"]);
	runBun([
		"git",
		"-C",
		join(ROOT, "orders-api-alice"),
		"commit",
		"--quiet",
		"-m",
		"orders api",
	]);
}

function runBun(cmd: string[], opts: { cwd?: string } = {}): string {
	const r = Bun.spawnSync(cmd, {
		cwd: opts.cwd ?? ROOT,
		stdout: "pipe",
		stderr: "pipe",
	});
	return dec.decode(r.stdout) + dec.decode(r.stderr);
}

const EXACT_QUESTION =
	"This repo does not seem to have health and status endpoints. According to IKEA policy it should. Do you want me to implement them for you?";

/** Org hub: an isolated buckle front serving the pilot rows, plus
 *  read-only transport probes of the LIVE hubs. */
async function orgHubLegs(): Promise<ReturnType<typeof startServer>> {
	process.env.BUCKLE_AUTH = "off";
	process.env.BUCKLE_POLICY = join(WT, "packages/buckle/routing-policy.yaml");
	process.env.BUCKLE_REPO_POLICY = join(ROOT, "pilot-policy.yaml");
	process.env.BUCKLE_SECRETS_HOME = join(ROOT, "secrets");
	const hub = startServer({ port: 17801, dbPath: join(ROOT, "buckle.db") });
	await manifestLeg();
	await hierarchyLegs();
	return hub;
}

async function manifestLeg(): Promise<void> {
	const res = await fetch("http://127.0.0.1:17801/repo-policy/manifest");
	const man = (await res.json()) as {
		sha256: string;
		rows: Array<{ missingQuestion: string; serviceId?: string }>;
	};
	const row = man.rows[0];
	const exact = row?.missingQuestion === EXACT_QUESTION;
	const scoped = row?.serviceId === "orders-api";
	record(
		"hub/policy-manifest",
		exact && scoped,
		`sha256:${man.sha256.slice(0, 12)} question=${exact ? "exact" : "WRONG"}`,
	);
}

/** Two-hub transport: bounded read-only probes of the LIVE sim and desktop
 *  hubs (never a write, never a crash experiment). */
async function hierarchyLegs(): Promise<void> {
	for (const [name, base] of [
		["nas", "http://nas.threads.dk:4101"],
		["desktop", "http://127.0.0.1:4111"],
	] as const) {
		try {
			const res = await fetch(
				`${base}/repo-policy/manifest`,
				{ signal: AbortSignal.timeout(3000) },
			);
			const man = (await res.json()) as { sha256?: string };
			// 200 = policy face served; 401 = face alive but gated (the hub
			// refuses unauthenticated manifest reads). Both are honest
			// evidence; anything else is RED.
			const alive = res.status === 200 || res.status === 401;
			record(
				`hub/hierarchy-${name}`,
				alive,
				`/repo-policy/manifest ${res.status} sha256:${String(man.sha256 ?? "-").slice(0, 12)}`,
			);
		} catch (e) {
			record(
				`hub/hierarchy-${name}`,
				false,
				`unreachable: ${String(e).slice(0, 60)}`,
			);
		}
	}
}

async function servedSha(): Promise<string> {
	const res = await fetch("http://127.0.0.1:17801/repo-policy/manifest");
	const man = (await res.json()) as { sha256: string };
	return man.sha256;
}

/** Two managed sessions (one per developer clone), isolated HOMEs — each
 *  top-level session gets its OWN NEED_DECISION with the exact question. */
async function sessionLegs(): Promise<void> {
	const cfg = join(ROOT, "repo-policy.json");
	const sha = await servedSha();
	const key = join(ROOT, "secrets/hub-key");
	writeFileSync(key, "bksk_pilot-local-key", { mode: 0o600 });
	writeFileSync(
		cfg,
		JSON.stringify({
			version: 1,
			hubs: [{ url: "http://127.0.0.1:17801", keyFile: key, sha256: sha }],
		}),
	);
	for (const dev of ["alice", "bob"] as const) {
		const sid = `pilot539-${dev}`;
		const out = (await oneSession(sid, join(ROOT, `orders-api-${dev}`))).out;
		const asked = out.includes("POLICY DECISION") && out.includes(EXACT_QUESTION);
		record(
			`session/${dev}`,
			asked,
			asked
				? `NEED_DECISION with the exact question (${sid})`
				: `no decision — output: ${out.slice(0, 3000)}`,
		);
	}
	// a lane (subagent transcript path) under alice shares HER decision —
	// same HOME (governor db) as alice, subagent transcript marker
	// The lane carries the PARENT's session id (real subagent behavior):
	// the ancestry walk needs the parent row in this db.
	const lane = await oneSession(
		"pilot539-alice",
		join(ROOT, "orders-api-alice"),
		{ transcript: "/tmp/fake/subagents/x.jsonl", home: join(ROOT, "home-pilot539-alice") },
	);
	// subagent lanes are NOT asked: the parent session owns the decision
	// (session-start runs the policy check only for top-level sessions) —
	// the lane inherits the parent's governing answer, zero duplicate asks
	const laneInherits =
		!lane.out.includes("POLICY DECISION") &&
		!lane.out.includes("POLICY REFERENCE") &&
		decisionCount("pilot539-alice#x") === 0;
	record(
		"session/ancestry-inherits",
		laneInherits,
		`subagent lane inherits the parent's decision (lane decisions=${decisionCount("pilot539-alice#x")})`,
	);
}

function decisionCount(sid: string): number {
	const r = Bun.spawnSync(
		[
			"bun",
			"-e",
			`const {Database}=require("bun:sqlite");const db=new Database(process.argv[1],{readonly:true});console.log(db.query("SELECT COUNT(*) n FROM events WHERE source=? AND kind='NEED_DECISION'").get(sid).n)`,
			join(ROOT, `home-${sid}/.cache/claude-governor/governor.db`),
			sid,
		],
		{ stdout: "pipe", stderr: "pipe" },
	);
	return Number(dec.decode(r.stdout).trim() || "0");
}

async function oneSession(
	sid: string,
	repo: string,
	opts: { transcript?: string; home?: string; config?: string } = {},
): Promise<{ out: string }> {
	const home = opts.home ?? join(ROOT, `home-${sid}`);
	mkdirSync(home, { recursive: true });
	const env: Record<string, string> = {
		HOME: home,
		PATH: process.env.PATH ?? "/usr/bin:/bin",
		SUSPENDERS_REPO_POLICY_CONFIG: opts.config ?? join(ROOT, "repo-policy.json"),
		// containment: the enrollment probe never reaches the live gate
		SUSPENDERS_BUCKLE_FRONT: "http://127.0.0.1:17899",
	};
	const child = Bun.spawn(
		["bun", join(WT, "packages/suspenders/hooks/session-start.ts")],
		{
			cwd: repo,
			env,
			stdin: "pipe",
			stdout: "pipe",
			stderr: "pipe",
		},
	);
	child.stdin.write(
		JSON.stringify({
			session_id: sid,
			cwd: repo,
			source: "startup",
			transcript_path: opts.transcript,
		}),
	);
	child.stdin.end();
	await child.exited;
	const out =
		(await new Response(child.stdout).text()) +
		(await new Response(child.stderr).text());
	return { out };
}

/** Approval → lane, exact-once: two developers authorize the SAME
 *  remediation concurrently against the org authority db. */
async function authorizeLeg(): Promise<void> {
	const auth: Record<string, string> = {
		HOME: join(ROOT, "auth-home"),
		PATH: process.env.PATH ?? "/usr/bin:/bin",
	};
	mkdirSync(auth.HOME, { recursive: true });
	const spec = join(ROOT, "remediation-spec.json");
	writeFileSync(
		spec,
		JSON.stringify({
			observedGap: "no independent reporter in the deployment manifest",
			acceptance:
				"independent reporter + monitoring wired to the reporter verdict",
		}),
	);
	const proposed = run(
		[
			"bun",
			script("policy-workflow.ts"),
			"propose",
			"orders-api",
			"--spec",
			spec,
			"--org",
			"org-pilot",
			"--project",
			"pilot",
		],
		auth,
	);
	const hash = /proposal hash: ([0-9a-f]{32})/.exec(proposed.out)?.[1] ?? "";
	record(
		"authorize/propose",
		hash !== "",
		hash === ""
			? `propose failed — output: ${proposed.out.slice(0, 220)}`
			: `proposal hash ${hash.slice(0, 12)}`,
	);
	// two developers authorize the same digest CONCURRENTLY (async spawns
	// against one authority db — SQLite serializes the mints)
	const mk = (dev: string) =>
		Bun.spawn(
			[
				"bun",
				script("policy-workflow.ts"),
				"authorize",
				remId,
				"--actor",
				dev,
				"--hash",
				hash,
				"--org",
				"org-pilot",
				"--project",
				"pilot",
			],
			{ env: auth, stdout: "pipe", stderr: "pipe" },
		);
	const remId = /remediation (PR-[0-9a-f]{8})/.exec(proposed.out)?.[1] ?? "";
	record("authorize/propose-id", remId !== "", `remediation ${remId}`);
	const [a, b] = [mk("alice"), mk("bob")];
	await a.exited;

	await b.exited;
	let outA =
		(await new Response(a.stdout).text()) +
		(await new Response(a.stderr).text());
	// symmetric retry: either approver may lose the db race — the retry
	// must land on the SAME already-authorized item
	if (a.exitCode !== 0) {
		const retry = Bun.spawnSync(
			[
				"bun",
				script("policy-workflow.ts"),
				"authorize",
				remId,
				"--actor",
				"alice-retry",
				"--hash",
				hash,
				"--org",
				"org-pilot",
				"--project",
				"pilot",
			],
			{ env: auth, stdout: "pipe", stderr: "pipe" },
		);
		outA += dec.decode(retry.stdout) + dec.decode(retry.stderr);
	}
	let outB =
		(await new Response(b.stdout).text()) +
		(await new Response(b.stderr).text());
	// concurrent approvers contend on the authority db — a busy loser
	// retries and must land on the SAME already-authorized item
	if (b.exitCode !== 0) {
		const retry = Bun.spawnSync(
			[
				"bun",
				script("policy-workflow.ts"),
				"authorize",
				remId,
				"--actor",
				"bob-retry",
				"--hash",
				hash,
				"--org",
				"org-pilot",
				"--project",
				"pilot",
			],
			{ env: auth, stdout: "pipe", stderr: "pipe" },
		);
		outB += dec.decode(retry.stdout) + dec.decode(retry.stderr);
	}
	const ids = [outA, outB]
		.map((o) => /work item (W[0-9]+)/.exec(o)?.[1])
		.filter((x) => typeof x === "string");
	const same = ids.length === 2 && ids[0] === ids[1];
	const adbPath = join(auth.HOME, ".cache/claude-governor/governor.db");
	if (!existsSync(adbPath)) {
		record(
			"authorize/exact-once",
			false,
			"authority db missing — propose failed",
		);
		return;
	}
	const adb = new Database(adbPath);
	const n = (
		adb.query("SELECT COUNT(*) n FROM work_items").get() as { n: number }
	).n;
	record(
		"authorize/exact-once",
		same && n === 1,
		same && n === 1
			? `approvals saw [${ids.join(", ")}]; work items in the authority graph: ${n}`
			: `approvals saw [${ids.join(", ")}]; items=${n}; A: ${outA.slice(0, 140)} | B: ${outB.slice(0, 140)}`,
	);
}

/** Exact-instance topology: two API instances, one dead — each sidecar
 *  probes ITS instance only, so verdicts differ where a naive LB probe
 *  would still hit the healthy replica part of the time. */
async function reporterLegs(): Promise<void> {
	const healthy = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		fetch: () => new Response("ok"),
	});
	// the dead instance: a CLOSED port (refused)
	const probe = join(WT, "packages/suspenders/deploy/healthcheck/probe.ts");
	const kids = [
		{ name: "healthy", url: healthy.url, port: 17811 },
		{ name: "dead", url: "http://127.0.0.1:17998", port: 17812 },
	].map((t) =>
		Bun.spawn(
			["bun", probe, "--target", t.url, "--listen", String(t.port), "--every", "300"],
			{ stdout: "ignore", stderr: "ignore" },
		),
	);
	const okHealthy = await waitVerdict(17811, 200);
	const okDead = await waitVerdict(17812, 502);
	record(
		"reporter/exact-instance",
		okHealthy && okDead,
		"healthy instance sidecar 200; dead instance sidecar 502",
	);
	for (const k of kids) k.kill();
	healthy.stop(true);
}

async function waitVerdict(port: number, status: number): Promise<boolean> {
	for (let i = 0; i < 40; i++) {
		try {
			const res = await fetch(`http://127.0.0.1:${port}/healthz`, {
				signal: AbortSignal.timeout(1000),
			});
			if (res.status === status) return true;
		} catch {
			// not up yet
		}
		await Bun.sleep(250);
	}
	return false;
}

/** Bounded negative: a wrong sha pin surfaces as honest "compliance
 *  unknown" — never silent, never false-compliant. */
async function negativeLegs(): Promise<void> {
	const badSha = join(ROOT, "cfg-bad-sha.json");
	writeFileSync(
		badSha,
		JSON.stringify({
			version: 1,
			hubs: [
				{
					url: "http://127.0.0.1:17801",
					keyFile: join(ROOT, "secrets/hub-key"),
					sha256: "0".repeat(64),
				},
			],
		}),
	);
	const out = (
		await oneSession(
			"pilot539-neg-sha",
			join(ROOT, "orders-api-alice"),
			{ config: badSha },
		)
	).out;
	record(
		"negative/wrong-sha",
		out.includes("POLICY CHECK UNAVAILABLE"),
		"wrong sha pin → POLICY CHECK UNAVAILABLE (compliance unknown)",
	);
}

/** Changed uncommitted source invalidates the assessment: three assess
 *  runs — fresh, reused (unchanged), invalidated (dirty tree). */
async function assessLeg(): Promise<void> {
	const env = {
		HOME: join(ROOT, "auth-home"),
		PATH: process.env.PATH ?? "/usr/bin:/bin",
	};
	const repo = join(ROOT, "orders-api-alice");
	const dep = join(ROOT, "deployment.json");
	writeFileSync(
		dep,
		JSON.stringify({
			service: "orders-api",
			manifestKnown: true,
			roles: ["api", "health-reporter"],
			reporterSupervision: "independent",
			monitoringWiring: "reporter-verdict",
		}),
	);
	const args = [
		"bun",
		script("policy-workflow.ts"),
		"assess",
		"orders-api",
		"--deployment",
		dep,
		"--org",
		"org-pilot",
		"--project",
		"pilot",
	];
	const first = run(args, env, repo);
	const clean = !first.out.includes("reusing assessment");
	const second = run(args, env, repo);
	const reused = second.out.includes("reusing assessment");
	const src = join(repo, "server.ts");
	writeFileSync(src, `process.title ??= "orders";
`);
	const third = run(args, env, repo);
	const invalidated = !third.out.includes("reusing assessment");
	record(
		"assess/reuse-and-invalidate",
		clean && reused && invalidated,
		`fresh=${clean} reused=${reused} dirty-invalidates=${invalidated}`,
	);
}

await main();
