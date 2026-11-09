// Live Docker bed. Startup ends at the first validated probe line.
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { promisify } from "node:util";
import type { BedDriver } from "./drivers.ts";
import type { Caps } from "./types.ts";

const run = promisify(execFile);
const timeout = 30_000;

export async function dockerCaps(bed = "docker-desktop"): Promise<Caps> {
	const info = await run(
		"docker",
		[
			"info",
			"--format",
			"{{.OperatingSystem}}|{{.KernelVersion}}|{{.NCPU}}|{{.MemTotal}}|{{.Architecture}}",
		],
		{ timeout },
	);
	const [os, kernel, ncpu, mem, arch] = info.stdout.trim().split("|");
	return {
		bed,
		host: os ?? "unreported",
		kernel: kernel ?? "unreported",
		arch: arch ?? "unreported",
		cpu: Number(ncpu ?? 0),
		memMiB: Math.round(Number(mem ?? 0) / 1048576),
	};
}

function nativePlatform(caps: Caps): string {
	if (caps.arch === "aarch64" || caps.arch === "arm64") return "linux/arm64";
	if (caps.arch === "x86_64" || caps.arch === "amd64") return "linux/amd64";
	throw new Error(`Unsupported Docker probe architecture: ${caps.arch}`);
}

export async function dockerImageIdentity(caps: Caps, image: string) {
	const platform = nativePlatform(caps);
	const result = await run(
		"docker",
		[
			"image",
			"inspect",
			"--platform",
			platform,
			"--format",
			"{{.Os}}/{{.Architecture}}|{{.Id}}",
			"--",
			image,
		],
		{ timeout },
	);
	const [resolvedPlatform, imageId] = result.stdout.trim().split("|");
	if (
		resolvedPlatform !== platform ||
		!/^sha256:[a-f0-9]{64}$/.test(imageId ?? "")
	)
		throw new Error(`Resident image does not resolve to ${platform}: ${image}`);
	return { image, platform, imageId };
}

async function waitForReady(name: string, startedAt: number): Promise<number> {
	const child = Bun.spawn(["docker", "start", "-a", name], {
		stdout: "pipe",
		stderr: "ignore",
		signal: AbortSignal.timeout(
			Math.max(1, Math.ceil(timeout - (performance.now() - startedAt))),
		),
	});
	const decoder = new TextDecoder();
	let bytes = 0;
	let output = "";
	let readyMs: number | undefined;
	try {
		for await (const chunk of child.stdout) {
			bytes += chunk.byteLength;
			if (bytes > 4096)
				throw new Error("Docker probe output exceeded 4096 bytes");
			output += decoder.decode(chunk, { stream: true });
			if (
				readyMs === undefined &&
				output.split("\n").slice(0, -1).includes("ready")
			)
				readyMs = Math.round(performance.now() - startedAt);
		}
		if ((await child.exited) !== 0 || readyMs === undefined)
			throw new Error("Docker probe exited without a successful ready marker");
		return readyMs;
	} finally {
		if (child.exitCode === null) child.kill();
		await child.exited;
	}
}

export function dockerDriver(caps: Caps): BedDriver {
	const platform = nativePlatform(caps);
	return {
		bed: caps.bed,
		caps,
		async measure(arm): Promise<number> {
			if (arm.kind !== "image")
				throw new Error("Docker probe requires an image arm");
			const name = `blam-artifact-${randomUUID()}`;
			const startedAt = performance.now();
			try {
				await run(
					"docker",
					[
						"create",
						"--name",
						name,
						"--platform",
						platform,
						"--pull",
						"never",
						"--network",
						"none",
						"--cap-drop",
						"ALL",
						"--security-opt",
						"no-new-privileges",
						"--entrypoint",
						"/bin/sh",
						"--",
						arm.id,
						"-c",
						"printf 'ready\\n'",
					],
					{ timeout },
				);
				return await waitForReady(name, startedAt);
			} finally {
				await run("docker", ["rm", "-f", name], { timeout }).catch((error) => {
					if (!String(error.stderr ?? "").includes("No such container"))
						throw error;
				});
			}
		},
	};
}
