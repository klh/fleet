// scripts/lib/release-version.ts — W1303.6: the one-version release core
// (PaaS standard §"One version for the whole repo", fleet-adapted). One
// version string lives in EVERY package manifest; this module reads the
// set from the root workspaces globs, refuses drift, plans + applies a
// synchronized bump (manifest versions AND internal @klh/* dep specs —
// whether P1's exact pins have landed or specs still read workspace:*),
// prepends the CHANGELOG.md release entry (merged item ids), and lands it
// all as ONE commit + ONE annotated vMAJOR.MINOR.PATCH tag. The machine
// stack.json pin stays operator-owned (0600) — this only RENDERS the hint.
//
// Pure plan/read surface + an injected git runner: tests drive fixtures.
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { STACK_PATH, tryLoadStack } from "../../hooks/lib/stack-config.ts";

export const SEMVER_RE = /^\d+\.\d+\.\d+$/;

export type BumpKind = "major" | "minor" | "patch";

export interface ManifestRef {
	/** absolute path of the package.json */
	path: string;
	/** repo-relative path (display + git add) */
	rel: string;
	version: string;
}

export interface Agreement {
	ok: boolean;
	/** the majority version when every manifest agrees, else null */
	current: string | null;
	/** every manifest that disagrees with the majority (or all, on total drift) */
	drift: { rel: string; version: string }[];
}

export interface ReleasePlan {
	current: string;
	next: string;
	tag: string;
	manifests: ManifestRef[];
	/** @klh/* dep specs rewritten to `next`, per manifest (name → old spec) */
	depRewrites: { rel: string; deps: Record<string, string> }[];
	changelogRel: string | null;
}

export type GitRunner = (args: string[]) => {
	code: number;
	out: string;
	err: string;
};

export const spawnGitRunner =
	(repo: string): GitRunner =>
	(args) => {
		const p = Bun.spawnSync(["git", "-C", repo, ...args], {
			stdout: "pipe",
			stderr: "pipe",
		});
		return {
			code: p.exitCode ?? 1,
			out: new TextDecoder().decode(p.stdout ?? new Uint8Array()),
			err: new TextDecoder().decode(p.stderr ?? new Uint8Array()),
		};
	};

export function parseSemver(
	v: string,
): { major: number; minor: number; patch: number } | null {
	if (!SEMVER_RE.test(v)) return null;
	const [major, minor, patch] = v.split(".").map(Number);
	return { major, minor, patch };
}

export function bumpSemver(v: string, kind: BumpKind): string {
	const p = parseSemver(v);
	if (!p) throw new Error(`release: not plain semver: ${v}`);
	if (kind === "major") return `${p.major + 1}.0.0`;
	if (kind === "minor") return `${p.major}.${p.minor + 1}.0`;
	return `${p.major}.${p.minor}.${p.patch + 1}`;
}

export function compareSemver(a: string, b: string): number {
	const pa = parseSemver(a);
	const pb = parseSemver(b);
	if (!pa || !pb) throw new Error(`release: not plain semver: ${a} vs ${b}`);
	if (pa.major !== pb.major) return pa.major - pb.major;
	if (pa.minor !== pb.minor) return pa.minor - pb.minor;
	return pa.patch - pb.patch;
}

/** Expand root `workspaces` globs (single-`*` segments, `!` negation — the
 *  forms this repo uses) to repo-relative dirs, whatever they hold. */
export function workspaceDirsAll(repo: string, patterns: string[]): string[] {
	const pos: string[] = [];
	const neg: string[] = [];
	for (const p of patterns) {
		if (p.startsWith("!")) neg.push(p.slice(1));
		else pos.push(p);
	}
	const found = new Set<string>();
	const walk = (dir: string, segs: string[], rel: string): void => {
		const seg = segs[0];
		if (seg === undefined) return;
		if (seg.includes("**"))
			throw new Error(
				`release: unsupported workspaces glob (no ** support): ${seg}`,
			);
		let entries: string[] = [];
		try {
			entries = readdirSync(dir, { withFileTypes: true });
		} catch {
			return;
		}
		for (const e of entries) {
			if (!e.isDirectory()) continue;
			if (e.name === ".git" || e.name === "node_modules") continue;
			if (seg !== "*" && seg !== e.name) continue;
			const childRel = rel ? `${rel}/${e.name}` : e.name;
			if (segs.length === 1) found.add(childRel);
			else walk(join(dir, e.name), segs.slice(1), childRel);
		}
	};
	for (const pat of pos) walk(repo, pat.split("/"), "");
	return [...found].filter(
		(d) => !neg.some((n) => d === n || d.startsWith(`${n}/`)),
	);
}

/** `workspaceDirsAll`, narrowed to the dirs that hold a package.json —
 *  the release core's manifest-discovery set. */
export function workspaceDirs(repo: string, patterns: string[]): string[] {
	return workspaceDirsAll(repo, patterns).filter((d) =>
		existsSync(join(repo, d, "package.json")),
	);
}

/** The one-version set: the root manifest + every workspace manifest. */
export function discoverManifests(repo: string): ManifestRef[] {
	const rootPath = join(repo, "package.json");
	if (!existsSync(rootPath))
		throw new Error(`release: no root package.json under ${repo}`);
	const root = JSON.parse(readFileSync(rootPath, "utf8")) as {
		version?: string;
		workspaces?: string[] | string;
	};
	const patterns = Array.isArray(root.workspaces)
		? root.workspaces
		: typeof root.workspaces === "string"
			? [root.workspaces]
			: [];
	const refs: ManifestRef[] = [
		{ path: rootPath, rel: "package.json", version: root.version ?? "" },
	];
	for (const d of workspaceDirs(repo, patterns)) {
		const p = join(repo, d, "package.json");
		const v =
			(JSON.parse(readFileSync(p, "utf8")) as { version?: string }).version ??
			"";
		refs.push({ path: p, rel: join(d, "package.json"), version: v });
	}
	return refs.sort((a, b) => a.rel.localeCompare(b.rel));
}

export const DEP_MAPS = [
	"dependencies",
	"devDependencies",
	"peerDependencies",
	"optionalDependencies",
] as const;

export function internalDepSpecs(
	json: Record<string, unknown>,
): Record<string, string> {
	const out: Record<string, string> = {};
	for (const m of DEP_MAPS) {
		const map = json[m];
		if (map === undefined || typeof map !== "object" || map === null) continue;
		for (const [name, spec] of Object.entries(map as Record<string, unknown>))
			if (name.startsWith("@klh/") && typeof spec === "string")
				out[name] = spec;
	}
	return out;
}

export function agreement(repo: string): Agreement {
	const refs = discoverManifests(repo);
	const counts = new Map<string, number>();
	for (const r of refs) counts.set(r.version, (counts.get(r.version) ?? 0) + 1);
	let current: string | null = null;
	let best = 0;
	for (const [v, n] of counts)
		if (
			n > best ||
			(n === best && current !== null && compareSemver(v, current) > 0)
		) {
			best = n;
			current = v;
		}
	const drift = refs
		.filter((r) => r.version !== current)
		.map((r) => ({ rel: r.rel, version: r.version }));
	return { ok: drift.length === 0, current, drift };
}

export function planRelease(
	repo: string,
	opts: { to?: string; kind?: BumpKind } = {},
): ReleasePlan {
	const agr = agreement(repo);
	if (!agr.ok || agr.current === null) {
		const rows = agr.drift.map(
			(d) => `${d.rel} @ ${d.version || "(no version)"}`,
		);
		throw new Error(
			`release: manifest drift — resolve before releasing:\n  ${rows.join("\n  ")}`,
		);
	}
	const current = agr.current;
	let next: string;
	if (opts.to !== undefined) {
		if (!SEMVER_RE.test(opts.to))
			throw new Error(
				`release: --to must be plain MAJOR.MINOR.PATCH: ${opts.to}`,
			);
		if (compareSemver(opts.to, current) <= 0)
			throw new Error(`release: --to ${opts.to} must be > current ${current}`);
		next = opts.to;
	} else {
		next = bumpSemver(current, opts.kind ?? "patch");
	}
	const manifests = discoverManifests(repo);
	const depRewrites: { rel: string; deps: Record<string, string> }[] = [];
	for (const m of manifests) {
		const json = JSON.parse(readFileSync(m.path, "utf8")) as Record<
			string,
			unknown
		>;
		const deps = internalDepSpecs(json);
		if (Object.keys(deps).length > 0) depRewrites.push({ rel: m.rel, deps });
	}
	return {
		current,
		next,
		tag: `v${next}`,
		manifests,
		depRewrites,
		changelogRel: existsSync(join(repo, "CHANGELOG.md"))
			? "CHANGELOG.md"
			: null,
	};
}

export function renderChangelogEntry(
	version: string,
	items: string[],
	date?: string,
): string {
	const day = date ?? new Date().toISOString().slice(0, 10);
	const bullets = items.length
		? items.map((i) => `- ${i}`).join("\n")
		: "- (no items recorded)";
	return `## ${version} — ${day}\n\n${bullets}`;
}

/** Prepend `entry` before the first `## ` section header (the release line),
 *  creating the file when absent. Returns the path written. */
export function prependChangelog(repo: string, entry: string): string {
	const path = join(repo, "CHANGELOG.md");
	if (!existsSync(path)) {
		writeFileSync(path, `# Changelog\n\n${entry}\n`);
		return path;
	}
	const text = readFileSync(path, "utf8");
	const lines = text.split("\n");
	const at = lines.findIndex((l) => l.startsWith("## "));
	const body = `${entry}\n`;
	if (at < 0) {
		writeFileSync(
			path,
			text.endsWith("\n") ? `${text}${body}` : `${text}\n${body}`,
		);
		return path;
	}
	lines.splice(at, 0, ...body.split("\n"));
	writeFileSync(path, lines.join("\n"));
	return path;
}

export interface ApplyResult {
	commit: string;
	tag: string;
	files: string[];
}

/** The synchronized bump: manifest versions + @klh/* dep specs + the
 *  CHANGELOG entry, ONE commit, ONE annotated tag. Refuses a dirty tree. */
export function applyRelease(
	repo: string,
	plan: ReleasePlan,
	items: string[],
	run: GitRunner = spawnGitRunner(repo),
): ApplyResult {
	const status = run(["status", "--porcelain"]);
	if (status.code !== 0)
		throw new Error(`release: git status failed: ${status.err.trim()}`);
	if (status.out.trim() !== "")
		throw new Error(`release: working tree not clean — commit or stash first`);
	const files: string[] = [];
	for (const m of plan.manifests) {
		const json = JSON.parse(readFileSync(m.path, "utf8")) as Record<
			string,
			Record<string, string>
		>;
		json.version = plan.next;
		for (const map of DEP_MAPS) {
			const deps = json[map];
			if (deps === undefined) continue;
			for (const name of Object.keys(deps))
				if (name.startsWith("@klh/")) deps[name] = plan.next;
		}
		writeFileSync(m.path, `${JSON.stringify(json, null, "\t")}\n`);
		files.push(m.rel);
	}
	const entry = renderChangelogEntry(plan.next, items);
	prependChangelog(repo, entry);
	files.push("CHANGELOG.md");
	const add = run(["add", ...files]);
	if (add.code !== 0)
		throw new Error(`release: git add failed: ${add.err.trim()}`);
	const msg = `release: v${plan.next} (${items.join(", ")})`;
	const commit = run(["commit", "-m", msg]);
	if (commit.code !== 0)
		throw new Error(`release: git commit failed: ${commit.err.trim()}`);
	const sha = run(["rev-parse", "HEAD"]);
	if (sha.code !== 0)
		throw new Error(`release: rev-parse failed: ${sha.err.trim()}`);
	const tag = run(["tag", "-a", plan.tag, "-m", `release ${plan.tag}`]);
	if (tag.code !== 0)
		throw new Error(`release: git tag failed: ${tag.err.trim()}`);
	return { commit: sha.out.trim(), tag: plan.tag, files };
}

export interface MachinePin {
	/** the operator-owned stack.json version pin, null when unset */
	pin: string | null;
	stackPath: string;
	/** the rendered install-output evidence line */
	line: string;
}

/** W1303.6 (5): RENDER the machine stack.json version hint — the conf
 *  itself is 0600 operator-owned and never written by tooling. `target` is
 *  the release TAG (vX.Y.Z): hubctl renders the pin as HUB_FLEET_REF and the
 *  W1302.3 preflight ls-remotes it, so a bare X.Y.Z names no ref (W1311). */
export function machineVersionHint(target?: string): MachinePin {
	const stack = tryLoadStack();
	const pin = stack?.version ?? null;
	const stackPath = STACK_PATH();
	if (pin === null)
		return {
			pin,
			stackPath,
			line: `STACK VERSION PIN: unset — set "version:" in ${stackPath} to pin every hub's git ref`,
		};
	const verdict =
		target !== undefined
			? target === pin
				? "matches"
				: `DRIFTS → set to ${target}`
			: "current";
	return {
		pin,
		stackPath,
		line: `STACK VERSION PIN: ${pin} (${verdict}) — machine conf ${stackPath}; hubctl renders every hub from it`,
	};
}

export function latestTag(run: GitRunner): string | null {
	const r = run(["tag", "--list", "v*", "--sort=-v:refname"]);
	if (r.code !== 0) return null;
	for (const line of r.out.split("\n")) {
		const t = line.trim();
		if (SEMVER_RE.test(t.slice(1))) return t;
	}
	return null;
}
