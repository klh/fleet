// fleet/registry.test.ts — registry parity + extension points (W950).
import { expect, test } from "bun:test";
import type { IngestConfig } from "../src/ingest.ts";
import { homeCtx, registerSessionSource, sessionSourcePaths, sessionSources } from "./registry.ts";

const FIXTURE = "/tmp/w950-registry-fixture";

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
  registerSessionSource({
    id: "goose",
    tool: "claude_code",
    dirs: () => ["/tmp/w950-goose-sessions"],
  });
  expect(sessionSources().map((a) => a.id)).toContain("goose");
  registerSessionSource({
    id: "goose",
    tool: "claude_code",
    dirs: () => ["/tmp/w950-goose-sessions-2"],
  });
  const goose = sessionSources().find((a) => a.id === "goose");
  expect(goose?.dirs(homeCtx(), fixtureConfig())).toEqual(["/tmp/w950-goose-sessions-2"]);
});
