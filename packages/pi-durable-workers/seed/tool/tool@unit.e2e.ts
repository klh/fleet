import { expect, test } from "@playwright/test";
import { scratchWorld } from "@klh/test-kit";
import { ToolDescriptorSchema, command, isolation } from "./build.ts";

test("descriptor rejects moving tags, runtime family and stable versions", () => {
 const descriptor = { schemaVersion: 1, family: "tool", version: "0.1.0-experimental.w2988",
  image: `ghcr.io/klh/fleet/tool-seed@sha256:${"a".repeat(64)}`,
  sourceCommit: "b".repeat(40), architecture: "amd64" };
 expect(ToolDescriptorSchema.safeParse(descriptor).success).toBe(true);
 for (const change of [{ image: "ghcr.io/klh/fleet/tool-seed:latest" }, { family: "pi" },
  { version: "2.2.0" }, { architecture: "arm64" }, { sourceCommit: "HEAD" }]) {
  expect(ToolDescriptorSchema.safeParse({ ...descriptor, ...change }).success).toBe(false);
 }
});
test("build context admits only recipe and tool manifest", async () => {
 const ignored = await Bun.file(new URL(".dockerignore", import.meta.url)).text();
 expect(ignored.trim().split("\n")).toEqual(["*", "!Dockerfile", "!tools.json"]);
 const recipe = await Bun.file(new URL("Dockerfile", import.meta.url)).text();
 expect(recipe).not.toMatch(/COPY (src|vendor|package)|bun install|pi-durable-seed/);
 expect(isolation).toEqual(expect.arrayContaining(["--read-only", "none", "1000:1000", "ALL"]));
});
test("failed subprocess refuses instead of returning success", async () => {
 const world = scratchWorld();
 try { await expect(command(["git", "-C", world.repo, "rev-parse", "missing-ref"]))
  .rejects.toThrow("Command failed"); } finally { world.clean(); }
});
