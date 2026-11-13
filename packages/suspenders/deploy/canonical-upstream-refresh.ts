import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { ResolvedProvider } from "@klh/settings/connections";
import type { StackConfig, HubProfile } from "../hooks/lib/stack-config.ts";
import { requiredProviders } from "../hooks/lib/hub-providers.ts";
import { discoverConnectionCatalogs } from "./hub-connection-catalog.ts";
import { renderUpstreams } from "./hubctl.ts";
import { runCommand } from "./litellm-activation.ts";

/** Existing maintenance refresh now derives canonical routes without touching LiteLLM. */
export async function refreshCanonicalUpstreams(
	stack: StackConfig,
	deps: {
		resolve?: (hub: HubProfile) => ResolvedProvider[];
		fetcher?: typeof fetch;
		read?: (path: string) => string;
		reload?: (name: string) => void;
	} = {},
): Promise<string[]> {
	const messages: string[] = [];
	for (const [name, hub] of Object.entries(stack.hubs)) {
		const required = (deps.resolve ?? requiredProviders)(hub);
		if (!required.some((profile) => profile.connection?.discovery.enabled))
			continue;
		renderUpstreams(hub, required);
		const desired = JSON.parse(
			renderUpstreams(
				hub,
				required,
				await discoverConnectionCatalogs(
					required,
					deps.fetcher,
					hub.upstreams?.groups,
				),
			),
		);
		let unchanged = false;
		if (!hub.deploy?.ssh && hub.deploy?.dir)
			try {
				const current = JSON.parse(
					(deps.read ?? ((path) => readFileSync(path, "utf8")))(
						join(hub.deploy.dir, "upstreams.hub.json"),
					),
				);
				unchanged =
					current.inherit_defaults === false &&
					JSON.stringify(current.groups) === JSON.stringify(desired.groups);
			} catch {
				/* Missing/stale applied routes need the normal checked reload. */
			}
		if (!unchanged)
			(
				deps.reload ??
				((label) =>
					runCommand([
						process.execPath,
						join(import.meta.dir, "hubctl.ts"),
						"reload-upstreams",
						label,
					]))
			)(name);
		messages.push(
			`${name}: canonical catalogs ${unchanged ? "unchanged" : "reconciled"}`,
		);
	}
	return messages;
}
