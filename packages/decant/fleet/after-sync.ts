// fleet/after-sync.ts — W950 self-extending miss path.
//
// After every CLI sync, catalog targets (W918 skills-CLI catalog) detected on
// this machine but not covered by a registered adapter are surfaced: unless
// DECANT_ADAPTER_MINT=0, each miss mints ONE `decant adapter: <cli-id>` work
// item through the work CLI (DECANT_WORK_BIN overrides the binary; default
// `work` on PATH). Items carry sample PATHS only — never transcript contents
// (scrub discipline); one pending item per cli-id, deduped against the work
// list and per-process.
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { agents } from "../../suspenders/hooks/lib/vendor/skills-agents.ts";
import { type HomeCtx, homeCtx, sessionSources } from "./registry.ts";

const ADAPTER_PREFIX = "decant adapter:";

/** One detected-but-unadapted catalog target. */
export interface CatalogMiss {
  /** W918 catalog target id. */
  id: string;
  /** Absolute home dir whose existence is the detection evidence. */
  homeDir: string;
}

/** Title of the work item that carries a given cli-id's adapter work. */
export function adapterTitle(id: string): string {
  return `${ADAPTER_PREFIX} ${id}`;
}

/**
 * Catalog targets with no registered adapter whose CLI home dir exists on
 * this machine. Detection evidence = the home dir; items carry sample PATHS
 * only, never contents. Entries whose catalog skillsDir is not home-anchored
 * (first segment not `.x`) is skipped — homes that resolve another way
 * (XDG / computed) would make a directory probe lie. Misses sharing one
 * home dir collapse to the first id in catalog order.
 */
export function catalogMisses(ctx: HomeCtx, adapted: Iterable<string>): CatalogMiss[] {
  const have = new Set(adapted);
  const misses: CatalogMiss[] = [];
  const seenHomes = new Set<string>();
  for (const [id, cfg] of Object.entries(agents)) {
    if (have.has(id)) continue;
    const seg = cfg.skillsDir.split("/")[0] ?? "";
    if (!seg.startsWith(".")) continue;
    const homeDir = join(ctx.home, seg);
    if (seenHomes.has(homeDir) || !existsSync(homeDir)) continue;
    seenHomes.add(homeDir);
    misses.push({ id, homeDir });
  }
  return misses;
}

/** Sample-paths-only description for the minted item (never contents). */
function missDesc(miss: CatalogMiss): string {
  return (
    `Catalog target '${miss.id}' has a CLI home dir on this machine ` +
    `(${miss.homeDir}) but no decant transcript adapter is registered. ` +
    "Adapter contract: registerSessionSource({id, tool, dirs}) in " +
    "packages/decant/fleet/registry.ts. Verification bar: parses >=1 real " +
    "transcript + golden test from a REDACTED fixture. Sample path above; " +
    "paths only, never transcript contents."
  );
}

/** Spawn override shape: full argv in, stdout out (null = failure). */
type SpawnFn = (argv: string[]) => string | null;

/** Injectable harness so tests never spawn a real work CLI. */
export interface AfterSyncDeps {
  /** Resolver context (default: process env + homedir). */
  ctx?: HomeCtx;
  /** Overrides DECANT_WORK_BIN (tests pin a fake). */
  workBin?: string;
  /** Pre-captured `work list` output; skips the real listing spawn. */
  listOutput?: string;
  /** Spawn override — receives full argv (bin + args); returns stdout, or
   * null on failure. */
  spawn?: (argv: string[]) => string | null;
  /** Hint-line sink (default: process.stderr). */
  log?: (line: string) => void;
}

const mintedMemo = new Set<string>();

/** The post-sync hook the CLI seam calls. Never throws — a work-graph miss
 * must not fail a sync. Returns the misses surfaced this run. */
export function afterSync(deps: AfterSyncDeps = {}): CatalogMiss[] {
  const surfaced: CatalogMiss[] = [];
  try {
    if (process.env.DECANT_ADAPTER_MINT === "0") return surfaced;
    const ctx = deps.ctx ?? homeCtx();
    const workBin = deps.workBin ?? process.env.DECANT_WORK_BIN ?? "work";
    const spawn = deps.spawn ?? defaultSpawn();
    const misses = catalogMisses(
      ctx,
      sessionSources().map((a) => a.id),
    );
    if (misses.length === 0) return surfaced;
    const existing = deps.listOutput ?? spawn([workBin, "list"]) ?? "";
    for (const miss of misses) {
      const title = adapterTitle(miss.id);
      if (mintedMemo.has(title) || existing.includes(title)) continue;
      surfaceMiss(spawn, workBin, miss);
      surfaced.push(miss);
    }
    return surfaced;
  } catch (error) {
    const sink = deps.log ?? ((line: string) => process.stderr.write(`${line}\n`));
    sink(
      `decant after-sync: adapter mint skipped ` +
        `(${error instanceof Error ? error.message : String(error)})`,
    );
    return surfaced;
  }
}

/** Mint one work item for a miss unless already minted this process. */
function surfaceMiss(spawn: SpawnFn, workBin: string, miss: CatalogMiss): void {
  const title = adapterTitle(miss.id);
  if (mintedMemo.has(title)) return;
  const ok = spawn([workBin, "add", title, "--tag", "decant-adapter", "--desc", missDesc(miss)]);
  if (ok != null) mintedMemo.add(title);
}

/** Real spawn: argv arrays, env spread (never replaces), status-gated. */
function defaultSpawn(): SpawnFn {
  return (argv) => {
    const [bin, ...args] = argv;
    const res = spawnSync(bin, args, {
      encoding: "utf8",
      env: { ...process.env },
    });
    return res.status === 0 ? (res.stdout ?? "") : null;
  };
}
