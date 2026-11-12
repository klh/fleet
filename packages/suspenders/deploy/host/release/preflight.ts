import { z } from "zod";
import { hostProcess } from "../process.ts";
import { RegistryMetadataSchema } from "./contract.ts";
import { parseJson } from "./evidence.ts";
import { withDeadline } from "./http.ts";

const PACKAGE_PATH = "/user/packages/container/fleet%2Fsupervisor-seed";
const INVENTORY_PATH =
	"/user/packages?package_type=container&per_page=100&page=";
const MAX_BYTES = 8 * 1024 * 1024;
const MAX_MS = 30_000;
const OwnerSchema = z.object({
	login: z.literal("klh"),
	type: z.literal("User"),
});
const RepositorySchema = z.object({
	full_name: z.literal("klh/fleet"),
	html_url: z.literal("https://github.com/klh/fleet"),
	private: z.boolean(),
	owner: OwnerSchema,
});
const AbsentSchema = z.strictObject({
	schemaVersion: z.literal(1),
	state: z.literal("absent-confirmed"),
	package: z.literal("fleet/supervisor-seed"),
	registry: z.literal("ghcr.io"),
	authenticatedOwner: OwnerSchema,
	repository: RepositorySchema,
	absence: z.strictObject({
		status: z.literal(404),
		message: z.literal("Package not found."),
		inventory: z.strictObject({
			complete: z.literal(true),
			pages: z.number().int().positive().max(10),
			packages: z.number().int().nonnegative().max(1000),
			bytes: z.number().int().positive().max(MAX_BYTES),
			elapsedMs: z.number().nonnegative().max(MAX_MS),
			sha256: z.string().regex(/^[a-f0-9]{64}$/),
		}),
	}),
	initialVisibility: z.literal("documented-private-default"),
	sourceLabel: z.literal("https://github.com/klh/fleet"),
	policySource: z.literal(
		"https://docs.github.com/en/packages/working-with-a-github-packages-registry/working-with-the-container-registry",
	),
});
export function uploadPreflight(raw: unknown) {
	if (RegistryMetadataSchema.safeParse(raw).success)
		return {
			state: "present" as const,
			package: RegistryMetadataSchema.parse(raw),
		};
	return { state: "bootstrap" as const, evidence: AbsentSchema.parse(raw) };
}
export type GitHubResponse = {
	status: number;
	headers: Record<string, string>;
	body: unknown;
	bytes: number;
};
export type GitHubApi = (
	path: string,
	bounds: { timeoutMs: number; maxBytes: number; signal: AbortSignal },
) => Promise<GitHubResponse>;
/** Header-bearing gh output preserves structured404 vs command/auth/network failure. */
export function gitHubApi(repository: string): GitHubApi {
	return async (path, bounds) => {
		const result = await hostProcess(
			["gh", "api", "--include", "--hostname", "github.com", path],
			{
				cwd: repository,
				timeoutMs: bounds.timeoutMs,
				maxBytes: bounds.maxBytes,
				signal: bounds.signal,
			},
		);
		if (result.signal) throw Error("GitHub API command signalled");
		const raw = new TextDecoder("utf-8", { fatal: true }).decode(result.stdout);
		const separator = raw.search(/\r?\n\r?\n/);
		if (separator < 0) throw Error("GitHub API response headers missing");
		const lines = raw.slice(0, separator).split(/\r?\n/);
		const status = Number(/^HTTP\/\d(?:\.\d)?\s+(\d{3})\b/.exec(lines[0])?.[1]);
		if (
			!Number.isInteger(status) ||
			status < 100 ||
			status > 599 ||
			(status >= 200 && status < 300) !== (result.code === 0)
		)
			throw Error("GitHub API status/exit mismatch");
		const headers: Record<string, string> = {};
		for (const line of lines.slice(1)) {
			const colon = line.indexOf(":");
			if (colon < 1) throw Error("GitHub API malformed header");
			const key = line.slice(0, colon).trim().toLowerCase();
			headers[key] = headers[key]
				? `${headers[key]},${line.slice(colon + 1).trim()}`
				: line.slice(colon + 1).trim();
		}
		const body = raw.slice(separator).trim();
		return {
			status,
			headers,
			body: parseJson(new TextEncoder().encode(body)),
			bytes: result.stdout.length + result.stderr.length,
		};
	};
}
/** No package is created here. Bootstrap proof names a documented default, never observed visibility. */
export async function readPackageMetadata(
	api: GitHubApi,
	options: { timeoutMs?: number; maxBytes?: number; maxPages?: number } = {},
) {
	const timeoutMs = options.timeoutMs ?? MAX_MS;
	const maxBytes = options.maxBytes ?? MAX_BYTES;
	const maxPages = options.maxPages ?? 10;
	if (
		!Number.isInteger(timeoutMs) ||
		timeoutMs <= 0 ||
		timeoutMs > MAX_MS ||
		!Number.isInteger(maxBytes) ||
		maxBytes <= 0 ||
		maxBytes > MAX_BYTES ||
		!Number.isInteger(maxPages) ||
		maxPages <= 0 ||
		maxPages > 10
	)
		throw Error("Preflight bounds invalid");
	const started = performance.now();
	let used = 0;
	return withDeadline(async (signal, wait) => {
		const get = async (path: string) => {
			const remaining = Math.floor(timeoutMs - (performance.now() - started));
			if (remaining <= 0 || used >= maxBytes)
				throw Error("Preflight total deadline/byte bound");
			const response = await wait(
				api(path, { timeoutMs: remaining, maxBytes: maxBytes - used, signal }),
			);
			if (!Number.isInteger(response.bytes) || response.bytes <= 0)
				throw Error("Preflight response byte accounting invalid");
			used += response.bytes;
			if (used > maxBytes) throw Error("Preflight total byte bound");
			return response;
		};
		const initial = await get(PACKAGE_PATH);
		if (initial.status === 200)
			return RegistryMetadataSchema.parse(initial.body);
		if (initial.status !== 404)
			throw Error(`GitHub package metadata HTTP ${initial.status}`);
		z.object({
			status: z.literal("404"),
			message: z.literal("Package not found."),
		}).parse(initial.body);
		const actor = await get("/user");
		if (actor.status !== 200) throw Error("Authenticated owner unavailable");
		const authenticatedOwner = OwnerSchema.parse(actor.body);
		const source = await get("/repos/klh/fleet");
		if (source.status !== 200)
			throw Error("Official source repository unavailable");
		const repository = RepositorySchema.parse(source.body);
		const names = new Set<string>();
		let pages = 0;
		let complete = false;
		const inventory = new Bun.CryptoHasher("sha256");
		for (let page = 1; page <= maxPages; page++) {
			const response = await get(INVENTORY_PATH + page);
			if (response.status !== 200)
				throw Error(`Owner inventory HTTP ${response.status}`);
			const entries = z
				.array(
					z.object({
						name: z.string().min(1).max(256),
						package_type: z.literal("container"),
						owner: z.object({ login: z.literal("klh") }),
					}),
				)
				.max(100)
				.parse(response.body);
			inventory.update(JSON.stringify(response.body)).update("\0");
			pages++;
			for (const entry of entries) {
				if (names.has(entry.name))
					throw Error("Ambiguous repeated inventory page");
				names.add(entry.name);
				if (entry.name === "fleet/supervisor-seed")
					throw Error("Package404 contradicts owner inventory");
			}
			const link = response.headers.link;
			const next = link ? /<([^>]+)>;\s*rel="next"/.exec(link) : null;
			if (link?.includes('rel="next"') && !next)
				throw Error("Ambiguous inventory pagination");
			if (next) {
				const target = new URL(next[1]);
				if (
					target.protocol !== "https:" ||
					target.host !== "api.github.com" ||
					target.pathname !== "/user/packages" ||
					target.searchParams.get("package_type") !== "container" ||
					target.searchParams.get("per_page") !== "100" ||
					target.searchParams.get("page") !== String(page + 1)
				)
					throw Error("Foreign inventory pagination");
			}
			if (entries.length < 100) {
				if (next) throw Error("Truncated inventory response");
				complete = true;
				break;
			}
		}
		if (!complete)
			throw Error("Inventory page bound reached before completion");
		return AbsentSchema.parse({
			schemaVersion: 1,
			state: "absent-confirmed",
			package: "fleet/supervisor-seed",
			registry: "ghcr.io",
			authenticatedOwner,
			repository,
			absence: {
				status: 404,
				message: "Package not found.",
				inventory: {
					complete: true,
					pages,
					packages: names.size,
					bytes: used,
					elapsedMs: performance.now() - started,
					sha256: inventory.digest("hex"),
				},
			},
			initialVisibility: "documented-private-default",
			sourceLabel: "https://github.com/klh/fleet",
			policySource:
				"https://docs.github.com/en/packages/working-with-a-github-packages-registry/working-with-the-container-registry",
		});
	}, timeoutMs);
}
