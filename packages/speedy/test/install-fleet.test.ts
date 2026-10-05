// W185 — bin/install-fleet.ts contract tests (bun test). HOME-isolated
// fixtures (process.env.HOME redirected, restored after); the only sockets
// are a loopback mock hub. Never the real ~/.claude, never external network.
import { test, expect, afterAll } from "bun:test";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import {
  buildPlan,
  enrollHub,
  firstPolicyPull,
  hubAsk,
  writeStandaloneHubConfig,
  type FleetFlags,
  type HubIO,
} from "../bin/install-fleet.ts";

const REPO = join(import.meta.dir, "..");
const FLEET = join(REPO, "bin/install-fleet.ts");
const SANDBOX = "/tmp/w185-fleet-home-" + process.pid;
const REAL_HOME = process.env.HOME;

afterAll(() => {
  process.env.HOME = REAL_HOME;
  rmSync(SANDBOX, { recursive: true, force: true });
});

function bareHome(): string {
  rmSync(SANDBOX, { recursive: true, force: true });
  mkdirSync(SANDBOX, { recursive: true });
  process.env.HOME = SANDBOX;
  return SANDBOX;
}

function freshHome(): string {
  bareHome();
  mkdirSync(SANDBOX + "/.claude/local-llm", { recursive: true });
  return SANDBOX;
}

function fakeIO(lines: string[]): { io: HubIO; out: () => string } {
  let i = 0;
  let acc = "";
  const io: HubIO = {
    tty: true,
    write: (s) => {
      acc += s;
    },
    readLine: () => lines[i++] ?? "",
  };
  return { io, out: () => acc };
}

const FULL_FLAGS: FleetFlags = { dryRun: false, skipModels: false, only: null };

function runCli(args: string[], home: string): { code: number; out: string } {
  const r = Bun.spawnSync([process.execPath, FLEET, ...args], {
    env: { ...process.env, HOME: home },
  });
  const dec = new TextDecoder();
  return {
    code: r.exitCode ?? 1,
    out: dec.decode(r.stdout) + dec.decode(r.stderr),
  };
}

// the mock W173 hub: enroll + first policy pull with menu (loopback only)
function startMock(): {
  srv: ReturnType<typeof Bun.serve>;
  url: string;
  CODE: string;
  TOKEN: string;
} {
  const CODE = "test-code-123";
  const TOKEN = "tok-w185-123";
  const srv = Bun.serve({
    port: 0,
    fetch: async (req) => {
      const u = new URL(req.url);
      if (req.method === "POST" && u.pathname === "/federation/enroll") {
        const body = (await req.json()) as { code?: string };
        if (body.code !== CODE)
          return Response.json({ error: "invalid" }, { status: 401 });
        return Response.json({
          spoke_id: "spoke-w185",
          spoke_token: TOKEN,
          policy_version: 1,
          dns_entries: ["suspenders.local", "belt.local"],
        });
      }
      if (req.method === "GET" && u.pathname === "/federation/policy") {
        if (req.headers.get("authorization") !== "Bearer " + TOKEN) {
          return new Response("no", { status: 401 });
        }
        return Response.json({
          policy_version: 1,
          menu: ["glm-5.3-flash", "local-swarm"],
          cr_queue: [],
        });
      }
      return new Response("nf", { status: 404 });
    },
  });
  return { srv, url: "http://127.0.0.1:" + srv.port + "/", CODE, TOKEN };
}

test("hygiene: no real hosts/paths/keys; 1500-line law", () => {
  const bad = [
    /\/Volumes\//,
    /\/Users\//,
    /threads\.dk/,
    /sk-[A-Za-z0-9]{16,}/,
    /AKIA[0-9A-Z]{16}/,
    /ghp_[A-Za-z0-9]{20,}/,
    /xox[baprs]-/,
  ];
  for (const f of ["bin/install-fleet.ts", "docs/laws.md"]) {
    const t = readFileSync(REPO + "/" + f, "utf8");
    for (const rx of bad) expect(t).not.toMatch(rx);
  }
  const lines = readFileSync(FLEET, "utf8").split("\n").length;
  expect(lines).toBeLessThan(1500);
});

test("hub ask 'y' end-to-end: prompts, enrolls, pulls, reports connected", async () => {
  const h = freshHome();
  const m = startMock();
  const { io, out } = fakeIO(["y", m.url, m.CODE]);
  await hubAsk(io);
  m.srv.stop(true);
  const cfg = JSON.parse(
    readFileSync(h + "/.claude/local-llm/hubs.json", "utf8"),
  ) as {
    hubs: { url: string; token_env: string }[];
  };
  expect(cfg.hubs).toHaveLength(1);
  expect(cfg.hubs[0].token_env).toBe("KLH_HUB_SPOKE_TOKEN");
  expect(out()).toContain("connected");
  expect(
    readFileSync(h + "/.claude/local-llm/last-policy-pull.json", "utf8"),
  ).toContain("menu");
});

test("wrong code: no roster, no env file (standalone fallback is hubAsk's job)", async () => {
  const h = freshHome();
  const m = startMock();
  const { io } = fakeIO([]);
  expect(await enrollHub(m.url, "wrong", io)).toBe(false);
  m.srv.stop(true);
  expect(existsSync(h + "/.claude/local-llm/hubs.json")).toBe(false);
  expect(existsSync(h + "/.claude/local-llm/hub.env")).toBe(false);
});

test("enroll happy path: W230 roster, token only in 0600 hub.env, first pull + menu", async () => {
  const h = freshHome();
  const m = startMock();
  const { io, out } = fakeIO([]);
  expect(await enrollHub(m.url, m.CODE, io)).toBe(true);
  await firstPolicyPull(m.url, m.TOKEN, io);
  m.srv.stop(true);
  const cfg = JSON.parse(
    readFileSync(h + "/.claude/local-llm/hubs.json", "utf8"),
  ) as {
    hubs: {
      name: string;
      url: string;
      token_env: string;
      spoke_token?: string;
      dns_entries: string[];
    }[];
  };
  expect(cfg.hubs).toHaveLength(1);
  expect(cfg.hubs[0].url).toBe(m.url.replace(/\/+$/, ""));
  expect(cfg.hubs[0].token_env).toBe("KLH_HUB_SPOKE_TOKEN");
  expect(cfg.hubs[0].spoke_token).toBeUndefined();
  expect(cfg.hubs[0].dns_entries).toEqual(["suspenders.local", "belt.local"]);
  const envf = h + "/.claude/local-llm/hub.env";
  expect((statSync(envf).mode & 0o777).toString(8)).toBe("600");
  expect(readFileSync(envf, "utf8")).toBe(`KLH_HUB_SPOKE_TOKEN=${m.TOKEN}\n`);
  expect(
    readFileSync(h + "/.claude/local-llm/last-policy-pull.json", "utf8"),
  ).toContain("menu");
  expect(out()).toContain("hub menu");
  expect(out()).toContain("glm-5.3-flash");
});

test("hub ask non-TTY: standalone roster 0600, hubs []", () => {
  const h = freshHome();
  const { io, out } = fakeIO([]);
  io.tty = false;
  hubAsk(io);
  expect(out()).toContain("non-interactive — standalone");
  const cfg = JSON.parse(
    readFileSync(h + "/.claude/local-llm/hubs.json", "utf8"),
  ) as { hubs: unknown[] };
  expect(cfg.hubs).toHaveLength(0);
  expect(
    (statSync(h + "/.claude/local-llm/hubs.json").mode & 0o777).toString(8),
  ).toBe("600");
});

test("hub ask 'n': default standalone", () => {
  const h = freshHome();
  const { io, out } = fakeIO(["n"]);
  hubAsk(io);
  expect(out()).toContain(
    "Do you want to buckle up and connect to a belt hub?",
  );
  expect(out()).toContain("standalone (default)");
  const cfg = JSON.parse(
    readFileSync(h + "/.claude/local-llm/hubs.json", "utf8"),
  ) as { hubs: unknown[] };
  expect(cfg.hubs).toHaveLength(0);
});

test("hub ask with existing roster: status only, never re-prompts", () => {
  const h = freshHome();
  writeStandaloneHubConfig();
  const roster = {
    hubs: [
      {
        name: "spoke-test",
        url: "http://hub.example",
        token_env: "KLH_HUB_SPOKE_TOKEN",
        dns_entries: [],
      },
    ],
  };
  writeFileSync(h + "/.claude/local-llm/hubs.json", JSON.stringify(roster));
  const { io, out } = fakeIO(["y"]); // would enroll if prompted — it must not
  hubAsk(io);
  expect(out()).toContain("enrolled to http://hub.example");
  expect(out()).not.toContain("Hub URL:");
});

test("--only dry-run: exactly the phase, no hub ask line", () => {
  const h = bareHome();
  const r = runCli(["--dry-run", "--only", "buckle"], h);
  expect(r.code).toBe(0);
  expect(r.out).toContain("buckle");
  expect(r.out).not.toContain("belt");
  expect(r.out).not.toContain("hub ask");
});

test("bad flag and bad --only: usage + exit 2", () => {
  const h = bareHome();
  expect(runCli(["--bogus"], h).code).toBe(2);
  expect(runCli(["--only", "nope"], h).code).toBe(2);
});

test("dry-run end-to-end: exit 0, plan on stdout, mutates nothing", () => {
  const h = bareHome();
  const r = runCli(["--dry-run"], h);
  expect(r.code).toBe(0);
  expect(r.out).toContain("klh fleet install — plan");
  expect(r.out).toContain("BELT_TIER=minimal");
  expect(r.out).toContain("hub ask");
  expect(existsSync(h + "/.claude")).toBe(false);
});

test("dry-run twice: byte-identical plan (no dup markers)", () => {
  const h = bareHome();
  const a = runCli(["--dry-run"], h);
  const b = runCli(["--dry-run"], h);
  expect(a.code).toBe(0);
  expect(b.code).toBe(0);
  expect(a.out).toBe(b.out);
});

test("plan: markers flip to present — skip; --only trims the plan", () => {
  const h = freshHome();
  writeFileSync(h + "/.claude/local-llm/registry.ts", "export const x = 1\n");
  mkdirSync(h + "/.claude/buckle/src", { recursive: true });
  writeFileSync(h + "/.claude/buckle/src/server.ts", "console.log(1)\n");
  mkdirSync(h + "/.claude/hooks/suspenders/bin", { recursive: true });
  writeFileSync(h + "/.claude/hooks/suspenders/bin/work.ts", "export {}\n");
  const plan = buildPlan(FULL_FLAGS);
  expect(plan.find((s) => s.phase === "belt")?.state).toBe("present — skip");
  expect(plan.find((s) => s.phase === "buckle")?.state).toBe("present — skip");
  expect(plan.find((s) => s.phase === "suspenders")?.state).toBe(
    "present — skip",
  );
  const only = buildPlan({ ...FULL_FLAGS, only: "buckle" });
  expect(only.map((s) => s.phase)).toEqual(["buckle"]);
  expect(h).toBe(SANDBOX);
});

test("plan: fresh home → install states, deterministic (idempotency)", () => {
  const h = freshHome();
  const a = buildPlan(FULL_FLAGS);
  const b = buildPlan(FULL_FLAGS);
  expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  const phases = a.map((s) => s.phase);
  expect(phases).toEqual([
    "deps",
    "belt",
    "buckle",
    "suspenders",
    "local",
    "local",
  ]);
  const belt = a.find((s) => s.phase === "belt");
  expect(belt?.state).toBe("install");
  expect(belt?.label).toContain("BELT_TIER=minimal");
  expect(a.find((s) => s.label.includes("hub ask"))).toBeDefined();
  expect(h).toBe(SANDBOX);
});
