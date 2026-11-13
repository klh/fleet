import { existsSync, readFileSync } from "node:fs";
import { z } from "zod";
import type { UpstreamGroup } from "../bin/console-html.ts";

const UpstreamsDisplaySchema = z.object({
	groups: z.record(z.string(), z.array(z.unknown()).nullable()),
	inherit_defaults: z.boolean().optional(),
});
function parseGroups(text: string) {
	const doc = UpstreamsDisplaySchema.parse(JSON.parse(text));
	return {
		groups: Object.fromEntries(
			Object.entries(doc.groups).map(([name, entries]) => [
				name,
				entries ?? [],
			]),
		),
		inherit: doc.inherit_defaults !== false,
	};
}

const ConnectionIdentitySchema = z.object({
	providerProfile: z
		.string()
		.regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/)
		.optional(),
	url: z.url(),
	dialect: z.enum(["openai", "anthropic"]),
	api_key_env: z
		.string()
		.regex(/^[A-Za-z_][A-Za-z0-9_]*$/)
		.optional(),
});
/** Identities stay process-local; return only a count, never endpoints or key references. */
function logicalConnectionCount(
	groups: Record<string, unknown[]>,
): number | null {
	const identities = new Set<string>();
	for (const entry of Object.values(groups).flat()) {
		const parsed = ConnectionIdentitySchema.safeParse(entry);
		if (!parsed.success) return null;
		const row = parsed.data;
		if (
			typeof entry !== "object" ||
			entry === null ||
			Object.hasOwn(entry, "api_key")
		)
			return null;
		const endpoint = new URL(row.url);
		if (
			!["http:", "https:"].includes(endpoint.protocol) ||
			endpoint.username ||
			endpoint.password ||
			endpoint.search ||
			endpoint.hash
		)
			return null;
		if (row.providerProfile) {
			identities.add(JSON.stringify(["profile", row.providerProfile]));
			continue;
		}
		const base = endpoint.pathname.replace(/\/+$/, "").replace(/\/v1$/, "");
		identities.add(
			JSON.stringify([endpoint.origin, base, row.api_key_env ?? null]),
		);
	}
	return identities.size;
}

/** Same group replacement precedence as Buckle; returns counts and provenance only. */
export function readEffectiveUpstreams(options: {
	basePath: string;
	overridePath?: string;
	overrideRequired?: boolean;
	hasFile?: (path: string) => boolean;
	readFile?: (path: string) => string;
}): {
	groups: UpstreamGroup[];
	source: string;
	connections: number | null;
} | null {
	const read = options.readFile ?? ((path) => readFileSync(path, "utf8"));
	const exists = options.hasFile ?? existsSync;
	try {
		if (
			options.overrideRequired &&
			(!options.overridePath || !exists(options.overridePath))
		)
			return null;
		const selected =
			options.overridePath && exists(options.overridePath)
				? parseGroups(read(options.overridePath))
				: null;
		const base =
			selected?.inherit === false
				? {}
				: parseGroups(read(options.basePath)).groups;
		const override = selected?.groups ?? {};
		return {
			connections: logicalConnectionCount({ ...base, ...override }),
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
			source:
				selected?.inherit === false
					? "machine override"
					: Object.keys(override).length
						? "fleet default + machine override"
						: "fleet default",
		};
	} catch {
		return null;
	}
}
