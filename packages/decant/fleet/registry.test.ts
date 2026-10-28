// fleet/registry.test.ts — registry parity + extension points (W950).
import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { IngestConfig } from "../src/ingest.ts";
import { homeCtx, registerSessionSource, sessionSourcePaths, sessionSources } from "./registry.ts";

const FIXTURE = mkdtempSync(join(tmpdir(), "w950-registry-fixture-"));

afterAll(() => rmSync(FIXTURE, { recursive: true, force: true }));

function fixtureConfig(): IngestConfig {
  return {
    claudeDir: `${FIXTURE}/claude`,
    codexDir: `${FIXTURE}/codex`,
    geminiDir: undefined,
    opencodeDir: undefined,
    opencodeDb: `${FIXTURE}/oc.db`,
  } as IngestConfig;
}

test("stock four cover the upstream source set", () => {
  expect(sessionSources().map((a) => a.id)).toEqual([
    "claude-code",
    "codex",
    "gemini-cli",
    "opencode",
  ]);
});

test("stock dir resolution matches upstream discover() arguments", () => {
  const cfg = fixtureConfig();
  expect(sessionSourcePaths(cfg)).toEqual([
    `${FIXTURE}/claude`,
    `${FIXTURE}/codex/sessions`,
    `${FIXTURE}/codex/archived_sessions`,
    `${FIXTURE}/oc.db`,
  ]);
  // geminiDir unset → no gemini path; the explicit opencode db always rides.
});

test("gemini + opencode config-driven branches", () => {
  const cfg = fixtureConfig();
  cfg.geminiDir = `${FIXTURE}/gemini`;
  cfg.opencodeDir = `${FIXTURE}/opencode`;
  expect(sessionSourcePaths(cfg)).toEqual([
    `${FIXTURE}/claude`,
    `${FIXTURE}/codex/sessions`,
    `${FIXTURE}/codex/archived_sessions`,
    `${FIXTURE}/gemini`,
    `${FIXTURE}/opencode`,
    `${FIXTURE}/oc.db`,
  ]);
});

test("registerSessionSource extends and replaces by id", () => {
  const gooseA = join(FIXTURE, "goose-sessions-a");
  const gooseB = join(FIXTURE, "goose-sessions-b");
  registerSessionSource({
    id: "goose",
    tool: "claude_code",
    dirs: () => [gooseA],
  });
  expect(sessionSources().map((a) => a.id)).toContain("goose");
  registerSessionSource({
    id: "goose",
    tool: "claude_code",
    dirs: () => [gooseB],
  });
  const goose = sessionSources().find((a) => a.id === "goose");
  expect(goose?.dirs(homeCtx(), fixtureConfig())).toEqual([gooseB]);
});
