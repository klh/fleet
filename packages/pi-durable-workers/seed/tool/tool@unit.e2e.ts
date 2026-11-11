import { expect, test } from "@playwright/test";
import { scratchWorld } from "@klh/test-kit";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { ToolDescriptorSchema, buildSeed, command, isolation } from "./build.ts";

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
test("fake Docker sees committed bytes when live files change after the clean check", async () => {
 const world = scratchWorld();
 const tools = await Bun.file(new URL("tools.json", import.meta.url)).text();
 const files = { Dockerfile: "FROM scratch\n\n", "tools.json": tools, ".dockerignore": "*\n!tools.json\n" };
 let staged = "";
 try {
  for (const [name, bytes] of Object.entries(files)) await Bun.write(join(world.repo, name), bytes);
  await command(["git", "-C", world.repo, "add", "."]);
  await command(["git", "-C", world.repo, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-qm", "Pinned context"]);
  const sha = (await command(["git", "-C", world.repo, "rev-parse", "HEAD"])).trim();
  const fakeDocker = async (args: string[]) => {
   if (args[0] === "docker") {
    staged = args.at(-1) ?? "";
    expect(staged).not.toBe(world.repo);
    expect(args).toContain(`SOURCE_COMMIT=${sha}`);
    for (const [name, bytes] of Object.entries(files)) expect(await Bun.file(join(staged, name)).text()).toBe(bytes);
    return "built";
   }
   const result = await command(args);
   if (args.includes("status")) {
    for (const name of Object.keys(files)) await Bun.write(join(world.repo, name), "MUTATED AFTER CHECK\n");
   }
   return result;
  };
  await buildSeed("0.1.0-experimental.race", world.repo, fakeDocker);
  expect(staged).not.toBe("");
  expect(existsSync(staged)).toBe(false);
 } finally { world.clean(); }
});

test("failed subprocess refuses instead of returning success", async () => {
 const world = scratchWorld();
 try { await expect(command(["git", "-C", world.repo, "rev-parse", "missing-ref"]))
  .rejects.toThrow("Command failed"); } finally { world.clean(); }
});
