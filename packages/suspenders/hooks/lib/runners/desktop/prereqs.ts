// prereqs.ts — W2869.3: honest desktop runner prerequisite detection.
// Nothing fakes success: missing docker, an unpinned/missing image, or an
// absent sbx is REPORTED, not papered over. sbx stays an optional
// candidate (Docker sign-in required; root #117833) — constrained Docker
// is the carrier for the desktop runner.
import { IMAGE_PIN } from "./seed.ts";
import { type RunArgv, runArgv } from "./spawn.ts";

export interface PrereqCheck {
	present: boolean;
	version: string | null;
	digest: string | null;
	pinned: boolean;
	error: string | null;
}

export interface DesktopPrereqReport {
	ok: boolean;
	docker: PrereqCheck;
	image: PrereqCheck;
	sbx: { present: boolean; note: string; error: string | null };
	missing: string[];
}

export const DESKTOP_RUNNER_IMAGE =
	"oven/bun:1@sha256:9114c058aeae42162ee16dd5084b95fe9473970bb6bcb5b232ab1630f0546895";

export const SBX_STATUS_NOTE =
	"sbx absent (recorded honestly): constrained Docker is the carrier; sbx stays an optional measured candidate (Docker sign-in required)";

const asText = (s: string): string => s.trim();

const checkOf = (
	r: { code: number; stdout: string; stderr: string },
	versioned: boolean,
): PrereqCheck => ({
	present: r.code === 0,
	version: versioned && r.code === 0 ? asText(r.stdout) : null,
	digest: !versioned && r.code === 0 ? asText(r.stdout) || null : null,
	pinned: true,
	error: r.code === 0 ? null : asText(r.stderr),
});

export const detectDesktopPrereqs = async (deps?: {
	run?: RunArgv;
	image?: string;
	dockerBin?: string;
}): Promise<DesktopPrereqReport> => {
	const run = deps?.run ?? runArgv;
	const dockerBin = deps?.dockerBin ?? "docker";
	const image = deps?.image ?? DESKTOP_RUNNER_IMAGE;
	const docker = await run([
		dockerBin,
		"version",
		"--format",
		"{{.Server.Version}}",
	]);
	const inspected = await run([
		dockerBin,
		"image",
		"inspect",
		"--format",
		'{{join .RepoDigests ","}}',
		image,
	]);
	const sbx = await run(["sbx", "--version"]);
	return finishReport(image, docker, inspected, sbx);
};

const finishReport = async (
	image: string,
	docker: { code: number; stdout: string; stderr: string },
	inspected: { code: number; stdout: string; stderr: string },
	sbx: { code: number; stdout: string; stderr: string },
): Promise<DesktopPrereqReport> => {
	const dockerCheck = checkOf(docker, true);
	const imageCheck = {
		...checkOf(inspected, false),
		pinned: IMAGE_PIN.test(image),
	};
	const sbxCheck = {
		present: sbx.code === 0,
		note:
			sbx.code === 0
				? "sbx CLI present but stays OPTIONAL: constrained Docker is the carrier (root #117833)"
				: SBX_STATUS_NOTE,
		error: sbx.code === 0 ? null : asText(sbx.stderr),
	};
	return {
		ok: dockerCheck.present && imageCheck.present && imageCheck.pinned,
		docker: dockerCheck,
		image: imageCheck,
		sbx: sbxCheck,
		missing: missingOf(dockerCheck, imageCheck),
	};
};

const missingOf = (docker: PrereqCheck, image: PrereqCheck): string[] => {
	const missing: string[] = [];
	if (!docker.present) {
		missing.push(`docker binary/daemon (${docker.error ?? "not found"})`);
	}
	if (!image.present) {
		missing.push(`digest-pinned runtime image (${image.error ?? "not found"})`);
	}
	if (image.present && !image.pinned) {
		missing.push("runtime image is not digest-pinned (@sha256:...)");
	}
	return missing;
};
