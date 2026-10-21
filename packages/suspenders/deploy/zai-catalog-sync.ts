#!/usr/bin/env bun
// Refresh one hub's private Z.ai account inventory. No key or response body
// is logged, and a failed fetch leaves the previous snapshot untouched.
import { defineVerb, runCli } from "../hooks/lib/verb-kit.ts";
import { loadStack } from "../hooks/lib/stack-config.ts";
import { fetchZaiCatalog, writeZaiSnapshot } from "./zai-catalog.ts";

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
				const keyFile = hub.secrets?.upstream_keys?.Z_AI_API_KEY;
				if (!path || !keyFile)
					throw new Error(
						"hub needs zai_catalog_file and Z_AI_API_KEY key path",
					);
				const snapshot = await fetchZaiCatalog(keyFile);
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
