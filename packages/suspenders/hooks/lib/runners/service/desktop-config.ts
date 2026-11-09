import { expandHome, type RunnerSettingsSchema } from "@klh/settings";
import { resolve } from "node:path";
import { readRunnerCredential } from "../api/credential.ts";
import { existingEntry } from "../durable/private-paths.ts";

export async function loadDesktopRuntimeConfig(
	config: ReturnType<typeof RunnerSettingsSchema.parse>,
) {
	const desktop = config.desktop;
	if (!desktop) throw new Error("runner.desktop_opt_in_required");
	const mintFile = resolve(expandHome(desktop.mint_credential_file));
	const controlFile = resolve(expandHome(config.credential_file));
	const [mintEntry, controlEntry] = await Promise.all([
		existingEntry(mintFile),
		existingEntry(controlFile),
	]);
	const sameFile =
		mintEntry &&
		controlEntry &&
		mintEntry.dev === controlEntry.dev &&
		mintEntry.ino === controlEntry.ino;
	if (
		mintFile === controlFile ||
		sameFile ||
		(mintEntry && mintEntry.nlink !== 1)
	)
		throw new Error("runner.separate_mint_credential_required");
	const seedRoot = resolve(expandHome(desktop.seed_root));
	const seedEntry = await existingEntry(seedRoot);
	if (
		!seedEntry?.isDirectory() ||
		seedEntry.uid !== process.getuid?.() ||
		(seedEntry.mode & 0o077) !== 0
	)
		throw new Error("runner.private_seed_root_required");
	return {
		image: desktop.image,
		seedRoot,
		baseUrl: config.identity_url,
		adminKey: readRunnerCredential(mintFile),
	};
}
