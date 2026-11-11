import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";

export const ToolManifestSchema = z.strictObject({
 schemaVersion: z.literal(1), family: z.literal("tool"), architecture: z.literal("amd64"),
 base: z.string().regex(/^oven\/bun:1@sha256:[a-f0-9]{64}$/),
 tools: z.array(z.string().regex(/^[a-z]+$/)).min(1),
 languageToolchains: z.array(z.literal("bun")),
 apt: z.record(z.string(), z.string().min(1)),
 amber: z.strictObject({ version: z.string(), sha256: z.string().regex(/^[a-f0-9]{64}$/) }),
});

export const ToolDescriptorSchema = z.strictObject({
 schemaVersion: z.literal(1), family: z.literal("tool"),
 version: z.string().regex(/^\d+\.\d+\.\d+-experimental[.\w-]*$/),
 image: z.string().regex(/^ghcr\.io\/klh\/fleet\/tool-seed@sha256:[a-f0-9]{64}$/),
 sourceCommit: z.string().regex(/^[a-f0-9]{40}$/), architecture: z.literal("amd64"),
});
export async function command(args: string[]) {
 const child = Bun.spawn(args, { stdout: "pipe", stderr: "inherit" });
 const output = await new Response(child.stdout).text();
 if (await child.exited) throw new Error(`Command failed: ${args[0]} ${args[1]}`);
 return output;
}
export const isolation = ["--platform", "linux/amd64", "--rm", "--read-only",
 "--user", "1000:1000", "--network", "none", "--cap-drop", "ALL",
 "--security-opt", "no-new-privileges", "--tmpfs", "/tmp:rw,noexec,nosuid,size=32m"];
export async function probe(image: string, manifestInput?: unknown) {
 const manifest = ToolManifestSchema.parse(manifestInput ?? await Bun.file(new URL("tools.json", import.meta.url)).json());
 for (const tool of manifest.tools) {
  await command(["docker", "run", ...isolation, image, tool, tool === "unzip" ? "-v" : "--version"]);
 }
 return command(["docker", "run", ...isolation, image, "bun", "-e", `
 import { existsSync } from 'node:fs';
 if (process.getuid() !== 1000 || process.arch !== 'x64') throw Error('identity');
 const forbidden = ['/opt/pi-durable-workers','/root/.aws','/root/.config','/var/run/docker.sock'];
 for (const p of forbidden) if (existsSync(p)) throw Error(p);
 try { await Bun.write('/rootfs-write-proof','x'); throw Error('writable root'); }
 catch(e) { if(e.message === 'writable root') throw e; }
 console.log(JSON.stringify({uid:process.getuid(),architecture:process.arch,rootfs:'read-only'}));`]);
}

export async function buildSeed(version: string, context = new URL(".", import.meta.url).pathname, run = command) {
 ToolDescriptorSchema.shape.version.parse(version);
 const sourceCommit = (await run(["git", "-C", context, "rev-parse", "HEAD"])).trim();
 ToolDescriptorSchema.shape.sourceCommit.parse(sourceCommit);
 const changes = await run(["git", "-C", context, "status", "--porcelain", "--", context]);
 if (changes.trim()) throw new Error("Commit tool source before building");
 const prefix = (await run(["git", "-C", context, "rev-parse", "--show-prefix"])).trim();
 const scratch = await mkdtemp(join(tmpdir(), "fleet-tool-build-"));
 try {
  for (const name of ["Dockerfile", "tools.json", ".dockerignore"]) {
   const bytes = await run(["git", "-C", context, "show", `${sourceCommit}:${prefix}${name}`]);
   await Bun.write(join(scratch, name), bytes);
  }
  const manifest = ToolManifestSchema.parse(await Bun.file(join(scratch, "tools.json")).json());
  const image = `ghcr.io/klh/fleet/tool-seed:${version}`;
  await run(["docker", "build", "--platform", "linux/amd64",
   "--build-arg", `SOURCE_COMMIT=${sourceCommit}`, "--build-arg", `TOOL_VERSION=${version}`,
   "-t", image, scratch]);
  return { image, manifest };
 } finally { await rm(scratch, { recursive: true, force: true }); }
}

if (import.meta.main) {
 const [action, value] = process.argv.slice(2);
 if (action === "probe" && value) console.log(await probe(value));
 else if (action === "build" && value) {
  const { image, manifest } = await buildSeed(value);
  console.log(await probe(image, manifest));
 } else throw new Error("Usage: bun build.ts build <experimental-version> | probe <image>");
}
