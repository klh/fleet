#!/usr/bin/env bun
// seed/build.ts — W2958: build the reproducible Pi Durable seed image and
// record its artifact manifest. No shell scripts — this bun script is the
// whole build. Steps:
//   1. stage the payload (pkg manifest + src + seed + vendor buckle log
//      face) into a scratch dir; swap @klh/buckle to file:
//   2. resolve deps on the host (generates the frozen bun.lock)
//   3. digest the payload (canonical seed digest + SBOM; generated
//      node_modules is excluded — the lockfile + dep pins carry it)
//   4. docker buildx --platform linux/amd64 --load
//   5. verify the digest pin resolves the way the runner references it
//   6. smoke the image under the executor's exact container contract:
//      read-only rootfs, cap-drop ALL, no-new-privileges, user 1000:1000,
//      network none, tmpfs /tmp + /workspace — non-root boot, readiness
//      after tools initialize, clean per-run writable overlay
//   7. write seed/manifest.json (0600, atomic) with digests, source
//      revision, resolved dep versions and SBOM
// Nothing is pushed anywhere; no cloud writes (W2958 boundary).
import { execFile } from "node:child_process";
import {
	cpSync,
	existsSync,
	mkdtempSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { promisify } from "node:util";
import {
	canonicalPolicyDigest,
	canonicalSeedDigest,
	digestOf,
	parseSeedManifest,
	writeSeedManifest,
	type SeedFile,
	type SeedManifest,
} from "../src/seed-manifest.ts";

const run = promisify(execFile);
const PKG = resolve(import.meta.dir, "..");
const REPO = resolve(PKG, "..", "..");
// Stage OUTSIDE the repo: bun resolves the nearest workspace root upward,
// so a stage under the worktree would save its lockfile to the ROOT and
// leave the build context without one. A temp dir is a standalone package.
const STAGE = mkdtempSync(join(tmpdir(), "pi-durable-seed-stage-"));
const MANIFEST = resolve(PKG, "seed/manifest.json");
const DOCKERFILE = resolve(PKG, "seed/payload/Dockerfile");
const BASE_PIN =
	"oven/bun:1@sha256:9114c058aeae42162ee16dd5084b95fe9473970bb6bcb5b232ab1630f0546895";
const UID = 1000;

/** Same daemon convention as the runner preflight (desktop context on
 *  darwin) — one docker, everywhere. */
const dockerArgv = (argv: readonly string[]): string[] => {
	const daemon =
		process.platform === "linux"
			? ["--host", "unix:///var/run/docker.sock"]
			: ["--context", "desktop-linux"];
	return ["docker", ...daemon, ...argv];
};

const docker = async (
	args: readonly string[],
	timeoutMs: number,
): Promise<{ stdout: string; stderr: string }> => {
	const { stdout, stderr } = await run("docker", dockerArgv(args).slice(1), {
		timeout: timeoutMs,
		maxBuffer: 16 * 1024 * 1024,
		killSignal: "SIGKILL",
	});
	return { stdout, stderr };
};

const writeJson = (dest: string, value: unknown): void => {
	writeFileSync(dest, `${JSON.stringify(value, null, "\t")}\n`);
};

/** Stage the exact payload the image copies; returns the package version. */
const stagePayload = (): string => {
	const pkgJson = JSON.parse(readFileSync(join(PKG, "package.json"), "utf8"));
	rmSync(STAGE, { recursive: true, force: true });
	mkdirSync(join(STAGE, "seed"), { recursive: true });
	mkdirSync(join(STAGE, "vendor/@klh/buckle/src"), { recursive: true });
	cpSync(join(PKG, "src"), join(STAGE, "src"), { recursive: true });
	cpSync(
		join(PKG, "seed/payload/readiness.ts"),
		join(STAGE, "seed/readiness.ts"),
	);
	cpSync(
		join(PKG, "seed/payload/policy.json"),
		join(STAGE, "seed/policy.json"),
	);
	// Minimal @klh/buckle face: the seed's only buckle import is
	// @klh/buckle/src/log (dependency-free). Full buckle drags
	// blam/settings/speedy/telemetry — against the minimal-payload law.
	cpSync(
		join(REPO, "packages/buckle/src/log.ts"),
		join(STAGE, "vendor/@klh/buckle/src/log.ts"),
	);
	writeJson(join(STAGE, "vendor/@klh/buckle/package.json"), {
		name: "@klh/buckle",
		version: pkgJson.dependencies["@klh/buckle"],
		private: true,
		description: "Minimal seed face: log only (W2958 staging)",
		type: "module",
	});
	writeJson(join(STAGE, "package.json"), {
		...pkgJson,
		dependencies: {
			...pkgJson.dependencies,
			"@klh/buckle": "file:./vendor/@klh/buckle",
		},
		devDependencies: undefined,
	});
	return pkgJson.version as string;
};

/** Payload file set for digest + SBOM: everything staged EXCEPT the
 *  generated node_modules (carried by the lockfile + dep pins). */
const collectPayload = (): SeedFile[] => {
	const files: SeedFile[] = [];
	const walk = (dir: string, prefix: string): void => {
		for (const entry of readdirSync(dir, { withFileTypes: true })) {
			const rel = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
			if (rel === "node_modules") continue;
			const abs = join(dir, entry.name);
			if (entry.isDirectory()) {
				walk(abs, rel);
				continue;
			}
			if (!entry.isFile()) throw new Error(`seed.stage.non_file:${rel}`);
			files.push({
				path: rel,
				bytes: readFileSync(abs) as unknown as Uint8Array,
			});
		}
	};
	walk(STAGE, "");
	if (files.length === 0) throw new Error("seed.stage.empty");
	return files;
};

/** Resolved dep versions as installed in the stage (host resolution uses
 *  the same registry the emulated in-image install then freezes). */
const resolvedDepVersions = (): { name: string; version: string }[] => {
	const out: { name: string; version: string }[] = [];
	const scopes = ["@earendil-works", "@klh"];
	for (const scope of scopes) {
		const base = join(STAGE, "node_modules", scope);
		if (!existsSync(base)) continue;
		for (const entry of readdirSync(base)) {
			const manifestPath = join(base, entry, "package.json");
			if (!existsSync(manifestPath)) continue;
			const m = JSON.parse(readFileSync(manifestPath, "utf8"));
			out.push({ name: m.name ?? `${scope}/${entry}`, version: m.version });
		}
	}
	const zodManifest = join(STAGE, "node_modules/zod/package.json");
	if (existsSync(zodManifest)) {
		const m = JSON.parse(readFileSync(zodManifest, "utf8"));
		out.push({ name: m.name ?? "zod", version: m.version });
	}
	return out.sort((a, b) => (a.name < b.name ? -1 : 1));
};

const main = async (): Promise<void> => {
	await docker(["info", "--format", "{{.ServerVersion}}"], 10_000);
	console.log("seed.build: docker daemon reachable");
	const version = stagePayload();
	console.log(`seed.build: payload staged at ${STAGE}`);
	// Plain install (the staged manifest already strips devDependencies) —
	// `--production` would skip writing bun.lock and the build context needs
	// it frozen.
	await run("bun", ["install", "--ignore-scripts"], {
		cwd: STAGE,
		timeout: 180_000,
	});
	console.log("seed.build: host dep resolution done (lockfile frozen)");

	const files = collectPayload();
	const seedDigest = canonicalSeedDigest(files);
	const seedBytes = files.reduce((s, f) => s + f.bytes.byteLength, 0);
	console.log(`seed.build: payload ${files.length} files → ${seedDigest}`);

	const tag = `klh/pi-durable-seed:${version}`;
	await docker(
		[
			"buildx",
			"build",
			"--platform",
			"linux/amd64",
			"--load",
			"-f",
			DOCKERFILE,
			"-t",
			tag,
			STAGE,
		],
		900_000,
	);
	console.log(`seed.build: image built ${tag}`);

	const { stdout: idOut } = await docker(
		["image", "inspect", "--format", "{{.Id}}", tag],
		15_000,
	);
	const imageId = idOut.trim();
	if (!/^sha256:[a-f0-9]{64}$/.test(imageId))
		throw new Error("seed.build.image_id_missing");
	const runtimeImage = `klh/pi-durable-seed@sha256:${imageId.slice("sha256:".length)}`;
	// The runner references the image as name@sha256:<digest> — verify THAT
	// ref resolves in the local cache before recording it (the exact lookup
	// checkDesktopImage performs at preflight).
	await docker(
		["image", "inspect", "--format", "{{.Id}}", runtimeImage],
		15_000,
	);
	console.log(`seed.build: digest pin resolves → ${runtimeImage}`);

	const isolation = [
		"--read-only",
		"--cap-drop",
		"ALL",
		"--security-opt",
		"no-new-privileges",
		"--user",
		`${UID}:${UID}`,
		"--network",
		"none",
		"--tmpfs",
		`/tmp:rw,noexec,nosuid,size=64m,uid=${UID},gid=${UID}`,
		"--tmpfs",
		`/workspace:rw,noexec,nosuid,size=128m,uid=${UID},gid=${UID}`,
	];
	const smoke = (args: string[]): Promise<{ stdout: string; stderr: string }> =>
		docker(["run", "--rm", ...isolation, tag, ...args], 60_000);

	const { stdout: uidOut } = await smoke(["id", "-u"]);
	if (uidOut.trim() !== String(UID))
		throw new Error(`seed.smoke.non_root_failed:${uidOut.trim()}`);
	console.log(`seed.smoke: non-root boot ok (uid ${uidOut.trim()})`);

	const { stdout: overlayOut } = await smoke([
		"sh",
		"-c",
		"(echo x > /opt/pi-durable-workers/blocked 2>/dev/null && echo ROOTFS-WRITABLE) || echo ROOTFS-RO; " +
			"echo x > /tmp/w && rm /tmp/w && echo TMP-OK; " +
			"echo x > /workspace/w && rm /workspace/w && echo WS-OK",
	]);
	if (
		!/ROOTFS-RO/.test(overlayOut) ||
		/ROOTFS-WRITABLE/.test(overlayOut) ||
		!/TMP-OK/.test(overlayOut) ||
		!/WS-OK/.test(overlayOut)
	)
		throw new Error(`seed.smoke.overlay_failed:${overlayOut}`);
	console.log("seed.smoke: read-only rootfs + writable overlay ok");

	const { stdout: readyOut } = await smoke([
		"bun",
		"run",
		"seed/readiness.ts",
		"1.4.2",
	]);
	const readyLine = readyOut
		.split("\n")
		.map((l) => l.trim())
		.find((l) => l.startsWith("{"));
	const parsed = readyLine ? JSON.parse(readyLine) : null;
	if (!parsed?.ready || !readyOut.includes("PI_DURABLE_SEED_READY"))
		throw new Error(`seed.smoke.readiness_failed:${readyOut.slice(0, 400)}`);
	console.log(`seed.smoke: readiness ok (${JSON.stringify(parsed.checks)})`);

	await smoke([
		"sh",
		"-ec",
		[
			"printf 'before\\n' > /workspace/fixture.txt",
			"rg -x before /workspace/fixture.txt",
			"fd -a '^fixture[.]txt$' /workspace | rg -x /workspace/fixture.txt",
			"bat --plain --line-range 1:1 /workspace/fixture.txt",
			"sd before after /workspace/fixture.txt",
			"rg -x after /workspace/fixture.txt",
			"printf true | jq -e .",
			"eza /workspace",
			"printf 'fixture.txt\\n' | fzf --filter fixture.txt",
			"ambr --version",
		].join("; "),
	]);
	console.log("seed.smoke: baked Speedy search, inspection and scoped edit ok");
	const { stdout: guestProtocol } = await smoke([
		"bun",
		"-e",
		`import { durableWorkers } from "./src/index.ts";
		const section = durableWorkers().sections?.find((entry) => entry.key === "workers-protocol");
		console.log(section?.render());`,
	]);
	if (
		!guestProtocol.includes("rg searches contents") ||
		!guestProtocol.includes("ambr for reviewed cross-file edits")
	)
		throw new Error("seed.smoke.speedy_protocol_missing");

	const { stdout: packageVersions } = await smoke([
		"dpkg-query",
		"-W",
		"-f=${Package}\\t${Version}\\n",
		"git",
		"ripgrep",
		"fd-find",
		"bat",
		"sd",
		"jq",
		"fzf",
		"eza",
		"unzip",
	]);
	const guestDeps = packageVersions
		.trim()
		.split("\n")
		.map((line) => {
			const [name, version] = line.split("\t");
			if (!name || !version)
				throw new Error("seed.smoke.invalid_guest_package");
			return { name, version };
		});
	const { stdout: amberVersion } = await smoke(["ambr", "--version"]);
	const amber = /^ambr "?([0-9]+\.[0-9]+\.[0-9]+)\b/.exec(
		amberVersion.trim(),
	)?.[1];
	if (amber !== "0.6.1") throw new Error("seed.smoke.unexpected_amber_version");

	const { stdout: revOut } = await run("git", ["rev-parse", "HEAD"], {
		cwd: PKG,
		timeout: 10_000,
	});
	// Dirty = payload SOURCE drift vs HEAD. The manifest is a RECORD of the
	// build, not source — counting its own re-stamp would make dirty:true
	// self-fulfilling (build → stamp → dirty forever).
	const { stdout: dirtyOut } = await run(
		"git",
		["status", "--porcelain", "--", ".", ":(exclude)seed/manifest.json"],
		{
			cwd: PKG,
			timeout: 10_000,
		},
	);
	const policy = {
		image: runtimeImage,
		network: "none",
		readOnlyRoot: true,
		capDropAll: true,
		noNewPrivileges: true,
		user: `${UID}:${UID}`,
		memoryMb: 512,
		cpus: 1,
		pidsLimit: 128,
		workMb: 128,
		tmpMb: 64,
	} as const;
	const manifest: SeedManifest = {
		schema_version: 1,
		kind: "pi-durable-seed",
		name: "klh/pi-durable-seed",
		version,
		source: {
			revision: revOut.trim(),
			dirty: dirtyOut.trim().length > 0,
			package: "@klh/pi-durable-workers",
		},
		base_image: BASE_PIN,
		runtime_image: runtimeImage,
		platform: "linux/amd64",
		seed: { digest: seedDigest, files: files.length, bytes: seedBytes },
		policy: {
			digest: canonicalPolicyDigest(policy),
			user: `${UID}:${UID}`,
			memory_mb: 512,
			cpus: 1,
			pids_limit: 128,
			work_mb: 128,
			tmp_mb: 64,
		},
		deps: [
			...resolvedDepVersions(),
			...guestDeps,
			{ name: "ambr", version: amber },
		].sort((a, b) => (a.name < b.name ? -1 : 1)),
		readiness: {
			command: ["bun", "run", "seed/readiness.ts"],
			marker: "PI_DURABLE_SEED_READY",
		},
		sbom: files.map((f) => ({
			path: f.path,
			sha256: digestOf(f.bytes),
			bytes: f.bytes.byteLength,
		})),
		built_at: new Date().toISOString(),
	};
	const checked = parseSeedManifest(manifest);
	if (!checked.success)
		throw new Error(
			`seed.build.manifest_invalid:${JSON.stringify(checked.error.issues).slice(0, 400)}`,
		);
	await writeSeedManifest(MANIFEST, manifest);
	console.log(`seed.build: manifest written ${MANIFEST}`);
	console.log(
		`seed.build: seedDigest=${seedDigest} policyDigest=${manifest.policy.digest} image=${runtimeImage}`,
	);
};

main()
	.catch((error) => {
		console.error(
			"seed.build failed:",
			error instanceof Error ? error.message : error,
		);
		process.exitCode = 1;
	})
	.finally(() => {
		rmSync(STAGE, { recursive: true, force: true });
		console.log("seed.build: stage cleaned");
	});
