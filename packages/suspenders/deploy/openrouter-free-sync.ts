#!/usr/bin/env bun
// Refresh the machine-local catalog snapshot consumed by hubctl push.
// It never handles keys and does not change a running hub by itself.
import { defineVerb, runCli } from "../hooks/lib/verb-kit.ts";
import { loadStack } from "../hooks/lib/stack-config.ts";
import { fetchFreeSnapshot, writeFreeSnapshot } from "./openrouter-free.ts";
import { refreshConfiguredOpenRouter } from "./openrouter-free-refresh.ts";

await runCli({
	prog: "openrouter-free-sync",
	about: "Refresh free text model routes from OpenRouter's catalog.",
	verbs: [
		defineVerb({
			name: "sync",
			usage:
				"usage: openrouter-free-sync sync --output /absolute/path/openrouter-free.<hub>.json",
			flags: ["--output"],
			reqFlags: ["--output"],
			run: async (parsed) => {
				const output = parsed.flag("--output");
				if (!output) throw new Error("missing --output");
				const snapshot = await fetchFreeSnapshot();
				const changed = writeFreeSnapshot(output, snapshot);
				console.log(
					`${changed ? "updated" : "unchanged"}: ${Object.keys(snapshot.groups).length} account-selectable free text routes (${snapshot.public_model_count} public records; ${snapshot.account_model_count} account-visible) at ${output}`,
				);
				for (const { id, reason } of snapshot.excluded_free_models)
					console.log(`excluded ${id}: ${reason}`);
			},
		}),
		defineVerb({
			name: "refresh-configured",
			usage: "usage: openrouter-free-sync refresh-configured",
			run: async () => {
				for (const message of await refreshConfiguredOpenRouter(loadStack()))
					console.log(message);
			},
		}),
	],
});
