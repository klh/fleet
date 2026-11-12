import type { Connection } from "@klh/settings/connections";
import { resolveAdapter } from "@klh/buckle/src/adapters/index.ts";

export function connectionAdapter(
	connection: Connection,
	dialect: "openai" | "anthropic",
	explicit?: unknown,
): string {
	const base =
		connection.adapter === "buckle" || connection.adapter === "openai"
			? "openai-compat"
			: connection.adapter;
	const family = resolveAdapter({ dialect, adapter: base }).family;
	const adapter =
		typeof explicit === "string"
			? explicit
			: ["openai-compat", "anthropic"].includes(family)
				? dialect === "anthropic"
					? "anthropic"
					: "openai-compat"
				: base;
	if (resolveAdapter({ dialect, adapter }).dialect !== dialect)
		throw new Error("Connection adapter and wire disagree");
	return adapter;
}

/** Existing path rewrites win; an endpoint pathname is otherwise a base, not an origin. */
export function connectionPaths(
	url: string,
	dialect: "openai" | "anthropic",
	config: Record<string, unknown>,
): Record<string, unknown> {
	const base = new URL(url).pathname.replace(/\/+$/, "");
	if (!base) return config;
	const paths =
		dialect === "anthropic"
			? ["/v1/messages", "/v1/messages/count_tokens"]
			: ["/v1/chat/completions", "/v1/responses", "/v1/embeddings"];
	const rewrites = Object.fromEntries(
		paths.map((path) => [
			path,
			`${base}${/\/v\d+$/.test(base) ? path.replace(/^\/v1/, "") : path}`,
		]),
	);
	const existing = config.path_rewrite;
	if (
		existing !== undefined &&
		(!existing || typeof existing !== "object" || Array.isArray(existing))
	)
		throw new Error("Invalid connection path rewrite");
	return {
		...config,
		path_rewrite: { ...rewrites, ...(existing as Record<string, unknown>) },
	};
}
