import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { z } from "zod";
export type { Connection } from "./settings.connections.ts";
import {
	ConnectionSchema,
	ConnectionKeySchema,
	ConnectionUrlSchema,
	type Connection,
} from "./settings.connections.ts";
import { LegacyProviderSchema } from "./settings.connection-legacy.ts";
import { SettingsSchema } from "./settings.schema.ts";
import { settingsPath } from "./settings.reader.ts";
export function validateCanonicalProviders(input: unknown): unknown {
	const parsed = SettingsSchema.safeParse(input);
	if (!parsed.success) throw new ConnectionConfigError();
	return parsed.data.providers;
}
import {
	ConnectionConfigError,
	parseConnectionJson,
	readConnectionFile,
} from "./settings.connection-file.ts";

export const ProviderEntrySchema = z.union([
	ConnectionSchema,
	LegacyProviderSchema,
]);
export const ProviderEntriesSchema = z.record(
	z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/),
	ProviderEntrySchema,
);
export const ProviderEndpointsSchema = z.strictObject({
	base: ConnectionUrlSchema.optional(),
	openai: ConnectionUrlSchema.optional(),
	anthropic: ConnectionUrlSchema.optional(),
	catalog: ConnectionUrlSchema.optional(),
});
export const NormalizedProviderSchema = z.strictObject({
	provider: z
		.string()
		.min(1)
		.max(256)
		.regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/),
	key: ConnectionKeySchema.optional(),
	env: z
		.string()
		.regex(/^[A-Z][A-Z0-9_]*$/)
		.optional(),
	endpoints: ProviderEndpointsSchema.optional(),
	connection: ConnectionSchema.optional(),
});
export const ResolvedProviderSchema = NormalizedProviderSchema.extend({
	name: z.string().min(1).max(128),
	env: z.string().nullable(),
	endpoints: ProviderEndpointsSchema,
});
export type ProviderEndpoints = z.infer<typeof ProviderEndpointsSchema>;
export type ProviderEntry = z.infer<typeof NormalizedProviderSchema>;
export type ResolvedProvider = z.infer<typeof ResolvedProviderSchema>;
export const PROVIDER_STACK_PATH = () =>
	process.env.KLH_STACK ??
	join(process.env.HOME ?? homedir(), ".config/klh/stack.json");

function credential(
	connection: Pick<Connection, "auth">,
	directory: string,
): string | undefined {
	const auth = connection.auth;
	if (!auth) return undefined;
	let raw: string | undefined;
	if (auth.kind === "inline") raw = auth.key;
	else if (auth.kind === "env") raw = process.env[auth.name];
	else {
		const file = auth.path.startsWith("~/")
			? join(process.env.HOME ?? homedir(), auth.path.slice(2))
			: auth.path;
		const text = readConnectionFile(
			file.startsWith("/") ? file : join(directory, file),
			false,
			4096,
		);
		if (auth.key_name) {
			const lines = text
				?.split(/\r?\n/)
				.filter((line) => line.startsWith(`${auth.key_name}=`));
			if (lines?.length !== 1) throw new ConnectionConfigError();
			raw = lines[0]?.slice(auth.key_name.length + 1).trim();
			if (
				raw &&
				((raw.startsWith('"') && raw.endsWith('"')) ||
					(raw.startsWith("'") && raw.endsWith("'")))
			)
				raw = raw.slice(1, -1);
		} else raw = text?.trim();
	}
	const parsed = ConnectionKeySchema.safeParse(raw);
	if (!parsed.success) throw new ConnectionConfigError();
	return parsed.data;
}

export function validateProviderConfig(
	input: unknown,
	directory = ".",
): Record<string, ProviderEntry> {
	const parsed = ProviderEntriesSchema.safeParse(input ?? {});
	if (!parsed.success) throw new ConnectionConfigError();
	const result: Record<string, ProviderEntry> = {};
	const envOwners = new Set<string>();
	for (const [name, entry] of Object.entries(parsed.data)) {
		if (entry.env && envOwners.has(entry.env))
			throw new ConnectionConfigError();
		if (entry.env) envOwners.add(entry.env);
		if ("kind" in entry) {
			result[name] = {
				provider: entry.kind === "provider" ? entry.provider : "buckle",
				key: credential(entry, directory),
				env: entry.env,
				endpoints: entry.endpoints,
				connection: entry,
			};
		} else {
			if (entry.key && entry.key_file) throw new ConnectionConfigError();
			const auth = entry.key
				? { kind: "inline" as const, key: entry.key }
				: entry.key_file
					? {
							kind: "file" as const,
							path: entry.key_file,
							key_name:
								entry.key_name ??
								`${name.toUpperCase().replace(/[^A-Z0-9]/g, "_")}_API_KEY`,
						}
					: entry.env
						? { kind: "env" as const, name: entry.env }
						: undefined;
			const endpoints =
				entry.endpoints ??
				(entry.base_url ? { openai: entry.base_url } : undefined);
			result[name] = {
				provider: entry.provider ?? name,
				...(auth ? { key: credential({ auth }, directory) } : {}),
				...(entry.env ? { env: entry.env } : {}),
				...(endpoints ? { endpoints } : {}),
			};
		}
	}
	return result;
}

export function loadProviderConfig(
	legacyFile = PROVIDER_STACK_PATH(),
): Record<string, ProviderEntry> {
	const canonical = settingsPath();
	const raw = readConnectionFile(canonical, true);
	const filename = raw === undefined ? legacyFile : canonical;
	const text = raw ?? readConnectionFile(legacyFile);
	const input = parseConnectionJson(text ?? "");
	if (raw !== undefined)
		return validateProviderConfig(
			validateCanonicalProviders(input),
			dirname(filename),
		);
	const doc = z
		.object({ providers: z.unknown().optional() })
		.passthrough()
		.safeParse(input);
	if (!doc.success) throw new ConnectionConfigError();
	return validateProviderConfig(doc.data.providers, dirname(filename));
}

export function resolveProvider(
	name: string,
	providers: Record<string, ProviderEntry>,
): ResolvedProvider | null {
	const entry = Object.hasOwn(providers, name) ? providers[name] : undefined;
	if (!entry) return null;
	const parsed = NormalizedProviderSchema.safeParse(entry);
	if (!parsed.success) throw new ConnectionConfigError();
	return {
		...parsed.data,
		name,
		env: parsed.data.env ?? null,
		endpoints: parsed.data.endpoints ?? {},
	};
}
export function profileForEnv(
	env: string,
	providers: Record<string, ProviderEntry>,
): ResolvedProvider | null {
	for (const [name, entry] of Object.entries(providers))
		if (entry.env === env) return resolveProvider(name, providers);
	return null;
}
export function profileForEndpoint(
	dialect: keyof ProviderEndpoints,
	url: string,
	providers: Record<string, ProviderEntry>,
): ResolvedProvider | null {
	for (const [name, entry] of Object.entries(providers))
		if (entry.endpoints?.[dialect] === url)
			return resolveProvider(name, providers);
	return null;
}
