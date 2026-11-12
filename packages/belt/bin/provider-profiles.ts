import { homedir } from "node:os";
import { join } from "node:path";
import { loadProviderConfig } from "@klh/speedy/src/provider-config.ts";
export {
	validateProviderConfig as validateProviderProfiles,
	resolveProvider as resolveProfile,
	profileForEnv,
	profileForEndpoint,
	type ProviderEntry,
	type ResolvedProvider,
	type ProviderEndpoints,
} from "@klh/speedy/src/provider-config.ts";
export const providerStackPath = (home?: string): string =>
	process.env.KLH_STACK ??
	join(home ?? process.env.HOME ?? homedir(), ".config/klh/stack.json");
export const loadProviderProfiles = (filename = providerStackPath()) =>
	loadProviderConfig(filename);
