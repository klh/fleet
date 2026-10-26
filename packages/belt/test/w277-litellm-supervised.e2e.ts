// W277 — litellm (:4100) joins the supervised set. Stub servers on free ports
// only — never touches the live :4100 engine or the real key files.
import { expect, test } from "@playwright/test";
import {
	mkdtempSync,
	mkdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	DEFAULT_PATHS,
	LITELLM_OK_STATUS,
	LITELLM_PROMETHEUS_SPEC,
	type LitellmPaths,
	litellmArgv,
	litellmTarget,
	litellmToolInstallArgs,
	loadKeys,
	prismaPreflight,
	prometheusPreflight,
} from "../bin/litellm-target.ts";
import { livenessReport } from "../bin/liveness.ts";
import {
	fleetTargets,
	probeTarget,
	type StatusDoc,
	Supervisor,
	tcpProbe,
} from "../bin/supervisor.ts";

const dir = mkdtempSync(join(tmpdir(), "w277-"));
test.afterAll(() => rmSync(dir, { recursive: true, force: true }));

const ZAI = "zai-test-secret-value";
const MASTER = "sk-master-test-secret";

// Fake litellm: /v1/models answers 200 with the right Bearer, 401 otherwise,
// and echoes whether the spawn env carried both keys.
const STUB = join(dir, "stub-litellm.ts");
writeFileSync(
	STUB,
	`const port = Number(process.argv[2]);
Bun.serve({ port, hostname: "127.0.0.1", fetch: (req) => {
	const envOk = process.env.Z_AI_API_KEY === ${JSON.stringify(ZAI)} && process.env.LITELLM_KEY === ${JSON.stringify(MASTER)};
	if (!envOk) return new Response("env", { status: 500 });
	const auth = req.headers.get("authorization");
	return new Response("{}", { status: auth === "Bearer ${MASTER}" ? 200 : 401 });
} });
`,
);

const paths = (over: Partial<LitellmPaths> = {}): LitellmPaths => {
	const zaiKeyFile = join(dir, "zai.key");
	const masterKeyFile = join(dir, "litellm.key");
	writeFileSync(zaiKeyFile, ZAI, { mode: 0o600 });
	writeFileSync(masterKeyFile, `${MASTER}\n`, { mode: 0o600 });
	return {
		...DEFAULT_PATHS,
		zaiKeyFile,
		masterKeyFile,
		// pinned into the tmpdir like the other keys — spreading DEFAULT_PATHS
		// left the optional-key files on the REAL machine paths, so loadKeys
		// hoisted live secret values into test output (W670 fixture-knob family)
		anthropicKeyFile: join(dir, "anthropic-absent.key"),
		openaiKeyFile: join(dir, "openai-absent.key"),
		copilotKeyFile: join(dir, "copilot-absent.key"),
		openrouterKeyFile: join(dir, "openrouter-absent.key"),
		log: join(dir, "litellm.log"),
		...over,
	};
};

let seq = 0;
const files = () => {
	seq++;
	return {
		statusFile: join(dir, `status-${seq}.json`),
		logFile: join(dir, `transitions-${seq}.log`),
	};
};

const freePort = (): number => {
	const s = Bun.serve({ port: 0, fetch: () => new Response("") });
	const port = s.port as number;
	s.stop(true);
	return port;
};

const waitFor = async (pred: () => boolean, ms = 10_000): Promise<void> => {
	const t0 = Date.now();
	while (!pred()) {
		if (Date.now() - t0 > ms) throw new Error("waitFor timed out");
		await Bun.sleep(20);
	}
};

const fast = {
	intervalMs: 30,
	failThreshold: 2,
	hungThreshold: 3,
	backoffBaseMs: 20,
	backoffCapMs: 2000,
	stableMs: 60_000,
	bindPollMs: 20,
};

const running: Supervisor[] = [];
test.afterEach(() => {
	for (const s of running.splice(0)) s.stop(true);
});
const start = (sup: Supervisor): Promise<void> => {
	running.push(sup);
	return sup.run();
};
const stateOf = (sup: Supervisor, port: number) =>
	sup.snapshot().targets.find((t) => t.port === port);

test.describe("keys — env first, then the 0600 files, never echoed", () => {
	test("files are read when env is empty @unit", () => {
		expect(loadKeys(paths(), {})).toEqual({
			Z_AI_API_KEY: ZAI,
			LITELLM_KEY: MASTER,
		});
	});

	test("inherited env wins over files @unit", () => {
		const k = loadKeys(paths(), { Z_AI_API_KEY: "e1", LITELLM_KEY: "e2" });
		expect(k).toEqual({ Z_AI_API_KEY: "e1", LITELLM_KEY: "e2" });
	});

	test("anthropic key: env wins, file fallback, absent = omitted (optional) @unit", () => {
		const k = loadKeys(paths(), { Z_AI_API_KEY: "z", LITELLM_KEY: "m" });
		expect(k.ANTHROPIC_API_KEY).toBeUndefined();
		const f = loadKeys(paths(), {
			Z_AI_API_KEY: "z",
			LITELLM_KEY: "m",
			ANTHROPIC_API_KEY: "env-a",
		});
		expect(f.ANTHROPIC_API_KEY).toBe("env-a");
		writeFileSync(join(dir, "anthropic-test.key"), "file-a\n", { mode: 0o600 });
		const g = loadKeys({
			...paths(),
			anthropicKeyFile: join(dir, "anthropic-test.key"),
		});
		expect(g.ANTHROPIC_API_KEY).toBe("file-a");
	});

	test("OpenAI key: env wins, file fallback, absent = omitted (optional) @unit", () => {
		const env = { Z_AI_API_KEY: "z", LITELLM_KEY: "m" };
		expect(loadKeys(paths(), env).OPENAI_API_KEY).toBeUndefined();
		const keyFile = join(dir, "openai-test.key");
		writeFileSync(keyFile, "file-o\n", { mode: 0o600 });
		const configured = paths({ openaiKeyFile: keyFile });
		expect(loadKeys(configured, env).OPENAI_API_KEY).toBe("file-o");
		expect(
			loadKeys(configured, { ...env, OPENAI_API_KEY: "env-o" }).OPENAI_API_KEY,
		).toBe("env-o");
	});

	test("OpenRouter inference key is optional, file-backed, and env-overridable @unit", () => {
		const keyFile = join(dir, "openrouter-test.key");
		writeFileSync(keyFile, "openrouter-test-secret\n", { mode: 0o600 });
		const configured = paths({ openrouterKeyFile: keyFile });
		expect(
			loadKeys(configured, { Z_AI_API_KEY: "z", LITELLM_KEY: "m" })
				.OPENROUTER_API_KEY,
		).toBe("openrouter-test-secret");
		expect(
			loadKeys(configured, {
				Z_AI_API_KEY: "z",
				LITELLM_KEY: "m",
				OPENROUTER_API_KEY: "override",
			}).OPENROUTER_API_KEY,
		).toBe("override");
	});

	test("zai key file must be a regular non-empty 0600 file @unit", () => {
		const env = {};
		// a rejected source throws naming the path only — never a value
		const rejects = (file: string) =>
			expect(() => loadKeys(paths({ zaiKeyFile: file }), env)).toThrow(
				new RegExp(`Z_AI_API_KEY.*${file.replace(/\./g, "\\.")}`),
			);
		// wrong mode (0644) → rejected
		const loose = join(dir, "zai-loose.key");
		writeFileSync(loose, ZAI, { mode: 0o644 });
		rejects(loose);
		// empty file → rejected
		const empty = join(dir, "zai-empty.key");
		writeFileSync(empty, "", { mode: 0o600 });
		rejects(empty);
		// directory → rejected
		const asDir = join(dir, "zai-dir.key");
		mkdirSync(asDir);
		rejects(asDir);
		// absent → rejected
		rejects(join(dir, "nope.key"));
		// present regular 0600 non-empty → accepted
		expect(loadKeys(paths(), env).Z_AI_API_KEY).toBe(ZAI);
	});

	test("missing keys throw naming the source, not a value @unit", () => {
		const p = paths({
			zaiKeyFile: join(dir, "nope.json"),
			masterKeyFile: join(dir, "nope.key"),
		});
		expect(() => loadKeys(p, {})).toThrow(/Z_AI_API_KEY.*LITELLM_KEY/);
		const half = paths({ masterKeyFile: join(dir, "nope.key") });
		let msg = "";
		try {
			loadKeys(half, {});
		} catch (e) {
			msg = String(e);
		}
		expect(msg).toContain("LITELLM_KEY");
		expect(msg).not.toContain(ZAI);
	});

	test("argv is the brief's command line, no key material @unit", () => {
		const argv = litellmArgv();
		expect(argv.slice(1)).toEqual([
			"--host",
			"127.0.0.1",
			"--config",
			DEFAULT_PATHS.config,
			"--port",
			"4100",
		]);
		expect(argv[0].endsWith("/.local/bin/litellm")).toBe(true);
	});
});

test.describe("fleet wiring", () => {
	test(":4100 is observed by the swarm; cloud-gateway alone owns it @unit", () => {
		const t = fleetTargets().find((x) => x.port === 4100);
		expect(t?.owned).toBe(false);
		expect(t?.kind).toBe("gateway");
		expect(t?.healthPath).toBe("/v1/models");
		expect(t?.okStatus).toEqual(LITELLM_OK_STATUS);
		expect(t?.spawn).toBeUndefined();
		expect(t?.preflight).toBeUndefined();
		expect(typeof t?.probeHeaders).toBe("function");
	});
});

test.describe("liveness probe — 200/401 healthy, anything else down", () => {
	const serve = (status: number) =>
		Bun.serve({
			port: 0,
			hostname: "127.0.0.1",
			fetch: () => new Response("", { status }),
		});

	for (const [status, http] of [
		[200, true],
		[401, true],
		[404, false],
		[500, false],
		[503, false],
	] as const) {
		test(`HTTP ${status} → http=${http} @unit`, async () => {
			const s = serve(status);
			const t = litellmTarget({
				paths: paths(),
				env: {},
				port: s.port as number,
			});
			expect(await probeTarget(t)).toEqual({ tcp: true, http });
			s.stop(true);
		});
	}

	test("probe sends the master key as Bearer @unit", async () => {
		let auth: string | null = null;
		const s = Bun.serve({
			port: 0,
			hostname: "127.0.0.1",
			fetch: (req) => {
				auth = req.headers.get("authorization");
				return new Response("{}");
			},
		});
		const t = litellmTarget({
			paths: paths(),
			env: {},
			port: s.port as number,
		});
		await probeTarget(t);
		expect(auth).toBe(`Bearer ${MASTER}`);
		s.stop(true);
	});

	test("closed port → tcp=false @unit", async () => {
		const t = litellmTarget({ paths: paths(), env: {}, port: freePort() });
		expect(await probeTarget(t)).toEqual({ tcp: false, http: false });
	});
});

test.describe("prisma preflight — alert, never auto-install", () => {
	test("real python: importable module ok, missing module reported @unit", () => {
		const py = Bun.which("python3");
		if (!py) return;
		// python3 lacks prisma in CI-like envs; either way the contract holds
		const r = prismaPreflight(py);
		if (r !== null) expect(r).toContain("prisma not importable");
		expect(prismaPreflight(join(dir, "no-python"))).toContain("unusable");
	});

	test("failing preflight → logged once + alert even while up @unit", async () => {
		const port = freePort();
		const f = files();
		const t = litellmTarget({
			paths: paths(),
			env: {},
			port,
			argv: [process.execPath, STUB, String(port)],
			preflight: () => "prisma not importable in litellm tool env",
		});
		const sup = new Supervisor([t], { ...f, ...fast });
		// An already-running engine can serve despite a broken restart dependency.
		// Failed preflight must not spawn a replacement to manufacture this state.
		const engine = Bun.serve({
			port,
			hostname: "127.0.0.1",
			fetch: () => new Response("{}"),
		});
		const done = start(sup);
		try {
			await waitFor(() => stateOf(sup, port)?.state === "up");
			const s = stateOf(sup, port);
			expect(s?.alert).toBe(true);
			expect(s?.preflightError).toContain("prisma");
			expect(s?.restarts).toBe(0);
			const log = readFileSync(f.logFile, "utf8");
			expect(log.match(/PREFLIGHT FAIL/g)?.length).toBe(1);

			const doc = JSON.parse(readFileSync(f.statusFile, "utf8")) as StatusDoc;
			const r = await livenessReport({
				targets: [t],
				status: doc,
				alive: () => true,
				now: Date.parse(doc.updated),
			});
			expect(r.alerts.some((a) => a.includes("preflight: prisma"))).toBe(true);
			sup.stop(true);
			await done;
		} finally {
			engine.stop(true);
		}
	}, 15_000);
});

test.describe("native LiteLLM Prometheus metrics dependency", () => {
	test("installer keeps LiteLLM version and Prometheus client pinned @unit", () => {
		const args = litellmToolInstallArgs("/opt/uv");
		expect(args).toEqual([
			"/opt/uv",
			"tool",
			"install",
			"--force",
			"--python",
			"3.13",
			"--with",
			"prisma==0.15.0",
			"--with",
			LITELLM_PROMETHEUS_SPEC,
			"litellm[proxy]==1.103.0",
		]);
	});

	test("missing Prometheus client is a preflight alert with a repair command @unit", () => {
		const py = Bun.which("python3");
		if (!py) return;
		const reason = prometheusPreflight(py);
		if (reason !== null) {
			expect(reason).toContain("prometheus_client not importable");
			expect(reason).toContain(LITELLM_PROMETHEUS_SPEC);
		}
		expect(prometheusPreflight(join(dir, "no-python"))).toContain("unusable");
	});
});

test.describe("supervision — stub litellm spawn/kill/respawn/backoff", () => {
	test("spawned with keys from files, killed, respawned inside backoff, healthy again @unit", async () => {
		const port = freePort();
		const f = files();
		let spawns = 0;
		const base = litellmTarget({
			paths: paths(),
			env: { PATH: process.env.PATH },
			port,
			argv: [process.execPath, STUB, String(port)],
			preflight: () => null,
		});
		const t = {
			...base,
			spawn: () => {
				spawns++;
				return (base.spawn as NonNullable<typeof base.spawn>)();
			},
		};
		const sup = new Supervisor([t], { ...f, ...fast });
		const done = start(sup);

		// cold: never up → spawned at once, keys reach the child (stub 200s)
		await waitFor(() => spawns === 1 && stateOf(sup, port)?.state === "up");
		expect(await probeTarget(t)).toEqual({ tcp: true, http: true });
		expect(stateOf(sup, port)?.alert).toBe(false);
		const firstPid = stateOf(sup, port)?.pid as number;

		const killedAt = Date.now();
		process.kill(firstPid, "SIGKILL");
		await waitFor(
			() =>
				spawns === 2 &&
				stateOf(sup, port)?.state === "up" &&
				stateOf(sup, port)?.pid !== firstPid,
		);
		const healedMs = Date.now() - killedAt;
		expect(healedMs).toBeLessThan(5_000);
		expect(await tcpProbe(port)).toBe(true);
		expect(stateOf(sup, port)?.restarts).toBe(2);

		const log = readFileSync(f.logFile, "utf8");
		expect(log).toContain("up→down");
		expect(log).toContain("down→backoff");
		expect(log).toContain("starting→up");
		// secrets never reach the transition log or status file
		expect(log).not.toContain(MASTER);
		expect(log).not.toContain(ZAI);
		expect(readFileSync(f.statusFile, "utf8")).not.toContain(MASTER);

		sup.stop(true);
		await done;
	}, 20_000);

	test("missing keys → spawn fails loudly, breaker caps the retries @unit", async () => {
		const port = freePort();
		const f = files();
		const t = litellmTarget({
			paths: paths({ masterKeyFile: join(dir, "absent.key") }),
			env: {},
			port,
			argv: [process.execPath, STUB, String(port)],
			preflight: () => null,
		});
		const sup = new Supervisor([t], {
			...f,
			...fast,
			backoffBaseMs: 5,
			maxRestarts: 3,
		});
		const done = start(sup);
		await waitFor(() => stateOf(sup, port)?.state === "unhealthy");
		const s = stateOf(sup, port);
		expect(s?.restarts).toBe(3);
		expect(s?.alert).toBe(true);
		expect(readFileSync(f.logFile, "utf8")).toContain("missing LITELLM_KEY");
		sup.stop(true);
		await done;
	}, 15_000);

	test("wedged engine (bound, 500s) is killed after hungThreshold and respawned @unit", async () => {
		const port = freePort();
		let spawned = 0;
		const killed: number[] = [];
		let healthy = false;
		const t = {
			...litellmTarget({
				paths: paths(),
				env: {},
				port,
				preflight: () => null,
			}),
			spawn: () => {
				spawned++;
				healthy = true;
				return { pid: 4242, exited: new Promise(() => {}), kill: () => {} };
			},
		};
		const sup = new Supervisor([t], {
			...files(),
			...fast,
			probe: async () => ({ tcp: true, http: healthy }),
			killPort: (p) => killed.push(p),
		});
		const done = start(sup);
		await waitFor(() => stateOf(sup, port)?.state === "up" && healthy);
		expect(killed).toEqual([port]);
		expect(spawned).toBe(1);
		sup.stop();
		await done;
	});
});
