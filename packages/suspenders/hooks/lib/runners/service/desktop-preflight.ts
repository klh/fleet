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

/** Inspect only the local Desktop cache. No pulls, containers, or model calls. */
export async function checkDesktopImage(image: string) {
	if (!/^[^\s@]+@sha256:[a-f0-9]{64}$/.test(image))
		throw new Error("runner.desktop_image_pin_required");
	try {
		const { stdout } = await execute(
			"docker",
			[
				"--context",
				"desktop-linux",
				"image",
				"inspect",
				"--format",
				"{{.Id}}",
				"--",
				image,
			],
			{ timeout: 5000, maxBuffer: 4096, killSignal: "SIGKILL" },
		);
		const imageId = stdout.trim();
		if (!/^sha256:[a-f0-9]{64}$/.test(imageId)) throw new Error();
		return imageId;
	} catch {
		throw new Error("runner.desktop_image_unavailable");
	}
}
