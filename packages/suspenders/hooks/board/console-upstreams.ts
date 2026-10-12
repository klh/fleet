import { existsSync, readFileSync } from "node:fs";
import { YAML } from "bun";
import type { UpstreamGroup } from "../bin/console-html.ts";

type Groups = Record<string, unknown[]>;
function parseGroups(text: string): Groups {
	const doc = YAML.parse(text) as { groups?: unknown } | null;
	if (
		!doc?.groups ||
		typeof doc.groups !== "object" ||
		Array.isArray(doc.groups)
	)
		throw new Error("upstream configuration has no groups mapping");
	const groups: Groups = {};
	for (const [name, entries] of Object.entries(doc.groups)) {
		if (entries !== null && !Array.isArray(entries))
			throw new Error("upstream group is not a deployment list");
		groups[name] = entries ?? [];
	}
	return groups;
}

/** Same group replacement precedence as Buckle; returns counts and provenance only. */
export function readEffectiveUpstreams(options: {
	basePath: string;
	overridePath?: string;
	hasFile?: (path: string) => boolean;
	readFile?: (path: string) => string;
}): { groups: UpstreamGroup[]; source: string } | null {
	const read = options.readFile ?? ((path) => readFileSync(path, "utf8"));
	const exists = options.hasFile ?? existsSync;
	try {
		const base = parseGroups(read(options.basePath));
		const override =
			options.overridePath && exists(options.overridePath)
				? parseGroups(read(options.overridePath))
				: {};
		return {
			groups: Object.entries({ ...base, ...override }).map(
				([name, entries]) => ({
					name,
					tiers: entries.length,
					dormant: entries.length === 0,
					source: Object.hasOwn(override, name)
						? "machine override"
						: "fleet default",
				}),
			),
			source: Object.keys(override).length
				? "fleet default + machine override"
				: "fleet default",
		};
	} catch {
		return null;
	}
}
