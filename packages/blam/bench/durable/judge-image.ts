// bench/durable/judge-image.ts — W2971.3 per-problem judge image builder:
// python runtime + patch(1) + the problem repo's OWN dependencies baked at
// BUILD time (network during build only — the judge RUN is networkless).
// The judge command imports the PATCHED tree via PYTHONPATH=/workspace so
// candidate patches take effect; site-packages only carries dependencies.
// Digest-pinned output: the builder resolves the base tag to a digest,
// builds, then prints the final image ref as name@sha256 — bench.local.json
// stores exactly that ref (config-over-code, 0600 machine-local).
// Usage: bun judge-image.ts --problem SPH-13926   (idempotent per repo+sha)
import { execFile } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { promisify } from "node:util";
import { loadProblem } from "./problem-set.ts";

const run = promisify(execFile);
const HERE = import.meta.dir;

const BASE = "python:3.11-slim";

async function baseDigest(base: string): Promise<string> {
	await run("docker", ["pull", "-q", base]);
	const inspect = await run("docker", ["image", "inspect", base], {
		maxBuffer: 4 * 1024 * 1024,
	});
	const info = JSON.parse(inspect.stdout) as {
		Id: string;
		RepoDigests: string[];
	}[];
	const repoDigest = info[0]?.RepoDigests.find((d) =>
		d.startsWith(base.split(":")[0]),
	);
	return repoDigest ?? info[0]?.Id ?? base;
}

function pythonProjectRoot(extracted: string): string {
	// the archive may carry the project at root or under a single top dir
	if (existsSync(join(extracted, "pyproject.toml"))) return extracted;
	const top = readdirSync(extracted).filter((n) => !n.startsWith("."));
	if (
		top.length === 1 &&
		existsSync(join(extracted, top[0], "pyproject.toml"))
	) {
		return join(extracted, top[0]);
	}
	throw new Error(
		`judge-image: no pyproject.toml at archive root or single top dir (saw: ${top.slice(0, 5).join(", ")})`,
	);
}

async function main(): Promise<void> {
	const argv = process.argv.slice(2);
	const problemId = argv.includes("--problem")
		? argv[argv.indexOf("--problem") + 1]
		: process.exit(2);
	const problem = loadProblem(join(HERE, "problem-sets.json"), problemId);

	// base source for dependency baking = the CLEAN archive at baseCommit
	// (same export contract as arm-runner; judge-only, never the seed)
	const local = JSON.parse(
		readFileSync(join(HERE, "bench.local.json"), "utf8"),
	) as {
		repos: Record<string, string>;
	};
	const repoRoot = local.repos[problem.repo];
	if (!repoRoot)
		throw new Error(`judge-image: repo root for ${problem.repo} missing`);
	mkdirSync(join(HERE, "ledger", "judge-builds"), { recursive: true });
	const tar = join(
		HERE,
		"ledger",
		"judge-builds",
		`${problem.repo}-${problem.baseCommit.slice(0, 12)}.tar`,
	);
	if (!existsSync(tar)) {
		await run("git", [
			"-C",
			repoRoot,
			"archive",
			"--output",
			tar,
			problem.baseCommit,
		]);
	}

	const scratch = mkdtempSync(join(tmpdir(), "blam-judge-"));
	try {
		const extracted = join(scratch, "tree");
		mkdirSync(extracted, { recursive: true });
		await run("tar", ["-xf", tar, "-C", extracted]);
		const project = pythonProjectRoot(extracted);
		const digest = await baseDigest(BASE);
		const image = `klh/blam-judge:${problem.repo}-${problem.baseCommit.slice(0, 12)}`;
		// idempotent per repo+base: an existing tagged judge image wins —
		// pip layers are not byte-reproducible, so rebuilding would mint a
		// new digest per call; the arm pins ONE judge face per problem repo
		try {
			const existing = await run("docker", ["image", "inspect", image], {
				maxBuffer: 4 * 1024 * 1024,
			});
			const info = JSON.parse(existing.stdout) as {
				RepoDigests: string[];
			}[];
			console.log(info[0].RepoDigests[0] ?? image);
			return;
		} catch {
			// not built yet — proceed to build
		}
		writeFileSync(
			join(scratch, "Dockerfile"),
			[
				`FROM ${digest}`,
				`RUN apt-get update && apt-get install -y --no-install-recommends patch git && rm -rf /var/lib/apt/lists/*`,
				// bake the project (deps + the package itself); pip build-time only
				`WORKDIR /build`,
				`COPY tree/ /build/`,
				`RUN pip install --no-cache-dir .[test] pytest || pip install --no-cache-dir . pytest`,
				`ENV PYTHONUNBUFFERED=1`,
				"",
			].join("\n"),
		);
		await run(
			"docker",
			["build", "--platform", "linux/amd64", "-t", image, scratch],
			{ maxBuffer: 64 * 1024 * 1024 },
		);
		const inspect = await run("docker", ["image", "inspect", image], {
			maxBuffer: 4 * 1024 * 1024,
		});
		const info = JSON.parse(inspect.stdout) as {
			Id: string;
			RepoDigests: string[];
		}[];
		const ref = info[0].RepoDigests[0] ?? `klh/blam-judge@${info[0].Id}`;
		console.log(ref);
	} finally {
		rmSync(scratch, { recursive: true, force: true });
	}
}
main().catch((e) => {
	const err = e as { stderr?: string; message?: string };
	const detail = (err.stderr ?? err.message ?? String(e))
		.split("\n")
		.filter((l) => /ERROR|error:|refused|not found|No matching/i.test(l))
		.slice(0, 6);
	console.error(
		`judge-image: REFUSED — ${detail.join(" | ") || (err.message ?? String(e)).split("\n")[0]}`,
	);
	process.exit(2);
});
