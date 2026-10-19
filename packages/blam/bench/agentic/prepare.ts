#!/usr/bin/env bun
// Materialize a fresh, versioned fixture repository. Refuses to overwrite.
import { cpSync, existsSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";

const target = resolve(process.argv[2] ?? "");
if (!process.argv[2]) throw new Error("usage: bun prepare.ts <new-directory>");
if (existsSync(target))
	throw new Error(`refusing existing fixture directory: ${target}`);
mkdirSync(target, { recursive: true });
cpSync(join(import.meta.dir, "fixture"), target, { recursive: true });
const git = (...args: string[]): void => {
	const p = Bun.spawnSync(["git", "-C", target, ...args], {
		stdout: "pipe",
		stderr: "pipe",
	});
	if (p.exitCode !== 0) throw new Error(new TextDecoder().decode(p.stderr));
};
git("init", "-q");
git("add", ".");
git(
	"-c",
	"user.name=BLAM",
	"-c",
	"user.email=blam@example.invalid",
	"commit",
	"-qm",
	"sealed fixture",
);
console.log(target);
