// fleet/after-sync.test.ts — miss detection + mint dedupe (W950).
import { afterAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { adapterTitle, afterSync, catalogMisses } from "./after-sync.ts";
import { homeCtx } from "./registry.ts";

// W1135.1.7: the fixture home is a mkdtemp dir, removed after the suite
// (it used to litter /tmp/w950-miss-fixture forever).
const FIXTURE = mkdtempSync(join(tmpdir(), "w950-miss-fixture-"));
afterAll(() => rmSync(FIXTURE, { recursive: true, force: true }));

// Real dirs (existsSync probes): .goose + .agents present in the fake home.
mkdirSync(`${FIXTURE}/.goose`, { recursive: true });
mkdirSync(`${FIXTURE}/.agents`, { recursive: true });
mkdirSync(`${FIXTURE}/.windsurf`, { recursive: true });
mkdirSync(`${FIXTURE}/skills`, { recursive: true }); // non-home-anchored

const STOCK = ["claude-code", "codex", "gemini-cli", "opencode"];

test("catalogMisses detects unadapted catalog targets by home dir", () => {
  const ctx = homeCtx({}, FIXTURE);
  const misses = catalogMisses(ctx, STOCK);
  const ids = misses.map((m) => m.id);
  expect(ids).toContain("goose");
  expect(ids).toContain("windsurf");
  // Three catalog entries anchor at ~/.agents (agents, antigravity, codex);
  // codex is stock, and the miss path collapses shared homes to the first
  // id — exactly one .agents miss.
  const agentMisses = misses.filter((m) => m.homeDir === `${FIXTURE}/.agents`);
  expect(agentMisses.length).toBe(1);
  // Non-home-anchored entries (openclaw: 'skills') never mint.
  expect(ids).not.toContain("openclaw");
});

test("adapterTitle is stable for dedupe", () => {
  expect(adapterTitle("goose")).toBe("decant adapter: goose");
});

test("afterSync mints one item per miss through the injected spawn", () => {
  const calls: string[][] = [];
  const surfaced = afterSync({
    ctx: homeCtx({}, FIXTURE),
    workBin: "work-fake",
    listOutput: "",
    spawn: (argv) => {
      calls.push(argv);
      return "";
    },
  });
  const adds = calls.filter((a) => a[1] === "add");
  expect(adds.length).toBe(surfaced.length);
  for (const a of adds) {
    expect(a[0]).toBe("work-fake");
    expect(a[1]).toBe("add");
    expect(a[2]?.startsWith("decant adapter: ")).toBe(true);
    expect(a).toContain("--tag");
    expect(a).toContain("decant-adapter");
    expect(a).toContain("--desc");
  }
  const desc = adds[0]?.[adds[0]?.indexOf("--desc") + 1] ?? "";
  expect(desc).toContain(FIXTURE);
});

test("afterSync dedupes against the work list", () => {
  const calls: string[][] = [];
  afterSync({
    ctx: homeCtx({}, FIXTURE),
    workBin: "work-fake",
    listOutput: "  ✓ W960   decant adapter: goose",
    spawn: (argv) => {
      calls.push(argv);
      return "";
    },
  });
  const adds = calls.filter((a) => a[1] === "add");
  expect(adds.map((a) => a[2])).not.toContain("decant adapter: goose");
});

test("afterSync honors DECANT_ADAPTER_MINT=0", () => {
  const before = process.env.DECANT_ADAPTER_MINT;
  process.env.DECANT_ADAPTER_MINT = "0";
  try {
    const calls: string[][] = [];
    afterSync({
      ctx: homeCtx({}, FIXTURE),
      workBin: "work-fake",
      spawn: (argv) => {
        calls.push(argv);
        return "";
      },
    });
    expect(calls.length).toBe(0);
  } finally {
    if (before === undefined) delete process.env.DECANT_ADAPTER_MINT;
    else process.env.DECANT_ADAPTER_MINT = before;
  }
});
