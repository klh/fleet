#!/usr/bin/env bun
// Refresh one hub's private Z.ai account inventory. No key or response body
// is logged, and a failed fetch leaves the previous snapshot untouched.
import { defineVerb, runCli } from "../hooks/lib/verb-kit.ts";
import { loadStack } from "../hooks/lib/stack-config.ts";
import {
	PROVIDER_STACK_PATH,
	loadProviderConfig,
	profileForEnv,
} from "../../speedy/src/provider-config.ts";
import { fetchZaiCatalog, writeZaiSnapshot } from "./zai-catalog.ts";

/** W1124.8.4: the Z.ai account key resolves from the inherited env or the
 *  CENTRAL provider profile bound to Z_AI_API_KEY (env NAME, never a hub
 *  key path). A missing binding names the migration — this consumer owns
 *  no legacy key-file read. */
export const zaiAccountKey = (
	stackPath: string = PROVIDER_STACK_PATH(),
): string => {
	if (process.env.Z_AI_API_KEY?.trim()) return process.env.Z_AI_API_KEY.trim();
	const profile = profileForEnv("Z_AI_API_KEY", loadProviderConfig(stackPath));
	if (profile?.key) return profile.key;
	throw new Error(
		"Z.ai account key: set Z_AI_API_KEY in the environment or a provider profile (stack.yaml providers, env: Z_AI_API_KEY)",
	);
};

await runCli({
	prog: "zai-catalog-sync",
	about: "Refresh a hub's account-visible Z.ai model inventory.",
	verbs: [
		defineVerb({
			name: "sync",
			usage: "usage: zai-catalog-sync sync --hub <hub-name>",
			flags: ["--hub"],
			reqFlags: ["--hub"],
			run: async (parsed) => {
				const name = parsed.flag("--hub");
				const hub = name ? loadStack().hubs[name] : undefined;
				if (!hub) throw new Error(`unknown Z.ai hub ${name ?? ""}`);
				const path = hub.upstreams?.zai_catalog_file;
				if (!path)
					throw new Error("hub needs zai_catalog_file (snapshot target)");
				const snapshot = await fetchZaiCatalog(zaiAccountKey());
				const changed = writeZaiSnapshot(path, snapshot);
				console.log(
					`${changed ? "updated" : "unchanged"}: ${snapshot.model_ids.length} account-visible Z.ai models at ${path}` +
						(snapshot.excluded_model_ids.length
							? ` (${snapshot.excluded_model_ids.length} non-chat excluded: ${snapshot.excluded_model_ids.join(", ")})`
							: ""),
				);
			},
		}),
	],
});
