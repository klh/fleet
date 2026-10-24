// test/helpers/cli-e2e-harness.ts — W932: the ONE CLI verb-matrix harness.
// Every matrix suite spawns the REAL CLI door (`bun hooks/bin/<cli>.ts <verb>`)
// against an isolated temp HOME (fresh governor.db — no live state, no
// network, no machine mutations) and asserts the round trip: exit codes,
// rendered faces, and the DB side effects behind them. The repo fixture is a
// real `git init` repo with a committed sentinel (work-cli.test.ts doctrine:
// a bare mkdir .git is not a gitdir; discovery would walk up into the
// checkout's own .git and collide project identity). The registry-parity
// parser reads the DOOR FACE: --help is generated from the live verb registry
// (W651), so parsing it yields the true registered-verb set without importing
// the CLI (whose top-level runCli would execute).
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface CliResult {
	code: number;
	out: string;
	err: string;
}

const BIN = join(import.meta.dir, "..", "..", "hooks", "bin");
const GOVDB = join(
	import.meta.dir,
	"..",
	"..",
	"hooks",
	"lib",
	"govdb",
	"govdb.ts",
);

/** One isolated fixture: temp HOME (fresh governor.db) + git-inited repo. */
export function cliFixture(label: string): {
	HOME: string;
	REPO: string;
	run: (file: string, args: string[]) => CliResult;
	/** Subprocess seam with the fixture HOME (coord-reads.test.ts pattern):
	 *  seeding/reads never share a sqlite handle with the CLIs. Throws on
	 *  non-zero exit. */
	seed: (code: string) => string;
	/** Query the fixture governor.db through the subprocess seam. */
	q: <T>(statement: string) => T[];
	/** Run a mutation against the fixture governor.db (row seeding). */
	ins: (statement: string, params: unknown[]) => void;
	registryFromHelp: (file: string) => string[];
	cleanup: () => void;
} {
	const HOME = mkdtempSync(join(tmpdir(), `w932-${label}-home-`));
	const REPO = mkdtempSync(join(tmpdir(), `w932-${label}-repo-`));
	mkdirSync(REPO, { recursive: true });
	const env = { ...process.env, HOME };
	const spawn = (cwd: string, file: string, args: string[]): CliResult => {
		const p = spawnSync("bun", [file, ...args], {
			cwd,
			env,
			encoding: "utf8",
			timeout: 30_000,
		});
		return {
			code: (p.status ?? p.exitCode ?? -1) as number,
			out: p.stdout ?? "",
			err: p.stderr ?? "",
		};
	};
	// project identity = realpath(git-common-dir); the sentinel commit gives
	// the work done evidence gate a real sha to verify against
	spawnSync("git", ["init", "-q", REPO], { stdout: "ignore" });
	spawnSync(
		"git",
		[
			"-c",
			"user.email=t@t",
			"-c",
			"user.name=t",
			"commit",
			"-qm",
			"W932 fixture sentinel",
			"--allow-empty",
		],
		{ cwd: REPO, stdout: "ignore" },
	);
	const head = spawnSync("git", ["rev-parse", "HEAD"], {
		cwd: REPO,
		encoding: "utf8",
	});
	const commit = (head.stdout ?? "").trim();
	const seed = (code: string): string => {
		const p = spawnSync("bun", ["-e", code], {
			env,
			encoding: "utf8",
			timeout: 30_000,
		});
		if (p.status !== 0) throw new Error(`seed failed: ${p.stderr ?? ""}`);
		return p.stdout ?? "";
	};
	const q = <T>(statement: string): T[] =>
		JSON.parse(
			seed(`
const { openGovernorDb } = await import(${JSON.stringify(GOVDB)});
console.log(JSON.stringify(openGovernorDb().query(${JSON.stringify(statement)}).all()));
`),
		) as T[];
	const ins = (statement: string, params: unknown[]): void => {
		seed(`const { openGovernorDb } = await import(${JSON.stringify(GOVDB)});
openGovernorDb().query(${JSON.stringify(statement)}).run(...${JSON.stringify(params)});
`);
	};
	const registryFromHelp = (file: string): string[] => {
		const r = spawn(REPO, join(BIN, file), ["--help"]);
		if (r.code !== 0) throw new Error(`${file} --help exited ${r.code}`);
		const first = (r.out.split("\n")[0] ?? "").trim();
		const at = first.lastIndexOf(". ");
		if (at < 0) throw new Error(`${file} --help unparseable: ${first}`);
		return first
			.slice(at + 2)
			.split(" | ")
			.map((s) => s.trim())
			.filter(Boolean);
	};
	return {
		HOME,
		REPO,
		COMMIT: commit,
		run: (file, args) => spawn(REPO, join(BIN, file), args),
		seed,
		q,
		ins,
		registryFromHelp,
		cleanup: () => {
			rmSync(HOME, { recursive: true, force: true });
			rmSync(REPO, { recursive: true, force: true });
		},
	};
}
