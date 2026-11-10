import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { hasScope } from "@klh/buckle/src/gov/scopes.ts";
import { createRunnerIdentity } from "../api/identity.ts";

const execute = promisify(execFile);

/** Inspect mint authority without creating a provider credential. */
export async function checkDesktopMintAuthority(baseUrl: string, key: string) {
	const identify = createRunnerIdentity({ baseUrl });
	const request = new Request(baseUrl, {
		headers: { authorization: `Bearer ${key}` },
	});
	const identity = await identify(request);
	if (!hasScope(identity.scopes, "buckle:admin:WRITE_"))
		throw new Error("runner.desktop_mint_authority_required");
}

/** Use the same daemon for preflight, execution and artifact export. */
export function runnerDockerArgv(
	argv: readonly string[],
	platform = process.platform,
): string[] {
	const daemon =
		platform === "linux"
			? ["--host", "unix:///var/run/docker.sock"]
			: ["--context", "desktop-linux"];
	return [argv[0] ?? "docker", ...daemon, ...argv.slice(1)];
}

/** Inspect only the local Desktop cache. No pulls, containers, or model calls. */
export async function checkDesktopImage(image: string) {
	if (!/^[^\s@]+@sha256:[a-f0-9]{64}$/.test(image))
		throw new Error("runner.desktop_image_pin_required");
	try {
		const { stdout } = await execute(
			"docker",
			runnerDockerArgv([
				"docker",
				"image",
				"inspect",
				"--format",
				"{{.Id}}",
				"--",
				image,
			]).slice(1),
			{ timeout: 5000, maxBuffer: 4096, killSignal: "SIGKILL" },
		);
		const imageId = stdout.trim();
		if (!/^sha256:[a-f0-9]{64}$/.test(imageId)) throw new Error();
		return imageId;
	} catch {
		throw new Error("runner.desktop_image_unavailable");
	}
}

/** Reject daemons that report missing resource controls required by the sandbox. */
export async function checkRunnerDockerLimits() {
	let warnings: string;
	try {
		const { stdout } = await execute(
			"docker",
			runnerDockerArgv(["docker", "info", "--format", "{{json .Warnings}}"]).slice(1),
			{ timeout: 5000, maxBuffer: 32_768, killSignal: "SIGKILL" },
		);
		warnings = stdout;
	} catch {
		throw new Error("runner.docker_info_unavailable");
	}
	if (/No (?:cpu cfs (?:quota|period)|memory limit|swap limit|pids limit) support/i.test(warnings))
		throw new Error("runner.docker_resource_limits_unavailable");
}
