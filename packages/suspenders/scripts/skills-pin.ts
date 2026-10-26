// scripts/skills-pin.ts — W1472: the ONE pin face for the skills vendor class
// (the build-vendor.ts analogue for the W292 hash-parity tests). Two declared
// manifests, one hash: skills-lock.json (repo root, the vercel-labs/skills
// local-lock format) pins each skills/<name>/ tree, and
// hooks/lib/vendor/skills-agents.pin.json pins the vendored registry and its
// license. computedHash = sha256 over every file's relative path then bytes,
// files in path order — the form that reproduces the CLI's own fleet pin
// (4a56f0c8…, lock commit 1d4c3ad2, a single-file tree). Path order here is
// code-unit (locale-free, so CI and laptops agree); the CLI's multi-file
// order is unverified, and every tree is single-file today.
// The skills-vendor-hash test recomputes through these exports; no flag
// reports drift (exit 1), --write is the deliberate, reviewed re-pin.
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { defineVerb, parseVerb } from "../hooks/lib/verb-kit.ts";
import { REPO_ROOT } from "./skills-ci.ts";

export const LOCK = "skills-lock.json";
export const VENDOR_DIR = "packages/suspenders/hooks/lib/vendor";
export const VENDOR_PIN = "skills-agents.pin.json";
export const REPIN = "bun packages/suspenders/scripts/skills-pin.ts --write";

interface LockEntry {
	source: string;
	sourceType: string;
	computedHash: string;
}
interface Lock {
	version: number;
	skills: Record<string, LockEntry>;
}
export interface VendorPin {
	version: number;
	upstream: { repo: string; npm: string; path: string; license: string };
	files: Record<string, string>;
}

const localSource = (name: string): string => `./skills/${name}`;

const readJson = <T>(path: string): T =>
	JSON.parse(readFileSync(path, "utf8")) as T;

export const readVendorPin = (root: string): VendorPin =>
	readJson<VendorPin>(join(root, VENDOR_DIR, VENDOR_PIN));

const writeJson = (path: string, value: unknown): void =>
	writeFileSync(path, `${JSON.stringify(value, null, "\t")}\n`);

const sha256 = (...parts: (string | Buffer)[]): string => {
	const hash = createHash("sha256");
	for (const part of parts) hash.update(part);
	return hash.digest("hex");
};

// .git/node_modules mirror the CLI's walk; .DS_Store is Finder noise a
// checkout never carries but a laptop tree does.
const SKIP_DIRS = new Set([".git", "node_modules"]);

const listFiles = (base: string, dir: string = base): string[] =>
	readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
		const full = join(dir, entry.name);
		if (entry.isDirectory())
			return SKIP_DIRS.has(entry.name) ? [] : listFiles(base, full);
		return entry.isFile() && entry.name !== ".DS_Store"
			? [relative(base, full).split(sep).join("/")]
			: [];
	});

export const skillTreeHash = (dir: string): string =>
	sha256(
		...listFiles(dir)
			.sort()
			.flatMap((file) => [file, readFileSync(join(dir, file))]),
	);

// A skill is a skills/<name>/ dir carrying SKILL.md — the CLI's discovery rule.
export const catalogHashes = (root: string): Record<string, string> => {
	const dir = join(root, "skills");
	return Object.fromEntries(
		readdirSync(dir, { withFileTypes: true })
			.filter(
				(entry) =>
					entry.isDirectory() && existsSync(join(dir, entry.name, "SKILL.md")),
			)
			.map((entry) => entry.name)
			.sort()
			.map((name) => [name, skillTreeHash(join(dir, name))]),
	);
};

export const catalogDrift = (root: string): string[] => {
	const actual = catalogHashes(root);
	const pinned = readJson<Lock>(join(root, LOCK)).skills;
	const problems = Object.entries(actual).flatMap(([name, hash]) => {
		const entry = pinned[name];
		if (entry === undefined)
			return [`skill ${name}: not pinned in ${LOCK} (tree hashes to ${hash})`];
		const found: string[] = [];
		if (entry.source !== localSource(name) || entry.sourceType !== "local")
			found.push(
				`skill ${name}: ${LOCK} declares ${entry.sourceType} ${entry.source}, expected local ${localSource(name)}`,
			);
		if (entry.computedHash !== hash)
			found.push(
				`skill ${name}: ${LOCK} pins ${entry.computedHash}, tree hashes to ${hash}`,
			);
		return found;
	});
	for (const name of Object.keys(pinned))
		if (!Object.hasOwn(actual, name))
			problems.push(
				`skill ${name}: pinned in ${LOCK} but skills/${name}/SKILL.md is gone`,
			);
	return problems;
};

const vendorFiles = (root: string): string[] =>
	readdirSync(join(root, VENDOR_DIR), { withFileTypes: true })
		.filter((entry) => entry.isFile() && entry.name !== VENDOR_PIN)
		.map((entry) => entry.name)
		.sort();

export const vendorDrift = (root: string): string[] => {
	const pin = readVendorPin(root);
	const source = `${pin.upstream.npm} ${pin.upstream.path}`;
	const problems = vendorFiles(root).flatMap((file) => {
		const expected = pin.files[file];
		if (expected === undefined)
			return [`vendor ${file}: not pinned in ${VENDOR_PIN}`];
		const actual = sha256(readFileSync(join(root, VENDOR_DIR, file)));
		return actual === expected
			? []
			: [
					`vendor ${file} (${source}): ${VENDOR_PIN} pins ${expected}, file hashes to ${actual}`,
				];
	});
	for (const file of Object.keys(pin.files))
		if (!existsSync(join(root, VENDOR_DIR, file)))
			problems.push(`vendor ${file}: pinned in ${VENDOR_PIN} but missing`);
	return problems;
};

// The deliberate re-pin: rewrites ONLY the computed blocks. The vendor pin's
// `upstream` declaration is hand-owned and survives untouched.
export const writePins = (root: string): void => {
	const lockPath = join(root, LOCK);
	const skills = Object.fromEntries(
		Object.entries(catalogHashes(root)).map(([name, computedHash]) => [
			name,
			{ source: localSource(name), sourceType: "local", computedHash },
		]),
	);
	writeJson(lockPath, { ...readJson<Lock>(lockPath), skills });
	const pinPath = join(root, VENDOR_DIR, VENDOR_PIN);
	const files = Object.fromEntries(
		vendorFiles(root).map((file) => [
			file,
			sha256(readFileSync(join(root, VENDOR_DIR, file))),
		]),
	);
	writeJson(pinPath, { ...readVendorPin(root), files });
};

const SPEC = defineVerb({
	name: "skills-pin",
	usage: "usage: skills-pin [--write]   (no flag: report drift, exit 1)",
	switches: ["--write"],
});

if (import.meta.main) {
	const out = parseVerb(SPEC, process.argv.slice(2));
	if (!out.ok) {
		console.error(`skills-pin: ${out.message}\n${SPEC.usage}`);
		process.exit(2);
	}
	if (out.parsed.flag("--write") === "true") {
		writePins(REPO_ROOT);
		console.log(`skills-pin: re-pinned ${LOCK} + ${VENDOR_PIN}`);
	} else {
		const problems = [...catalogDrift(REPO_ROOT), ...vendorDrift(REPO_ROOT)];
		for (const problem of problems) console.error(`DRIFT: ${problem}`);
		if (problems.length > 0) {
			console.error(`re-pin only after reviewing the change: ${REPIN}`);
			process.exit(1);
		}
		console.log("skills-pin: catalog + vendored registry match their pins");
	}
}
