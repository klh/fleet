import { imageCreated } from "../build.ts";
import { join, basename } from "node:path";
import { publisherIdentity, type PublisherIdentity } from "./identity.ts";
import { gitHubApi, readPackageMetadata } from "./preflight.ts";
import { boundedBody, withDeadline } from "./http.ts";
export type Fetcher = (input: string, init?: RequestInit) => Promise<Response>;
import { hostProcess } from "../process.ts";
import { z } from "zod";
import { DigestSchema, REPOSITORY } from "./contract.ts";
import { hash, parseJson } from "./evidence.ts";
import { producerStage, type ReleaseDriver } from "./workflow.ts";

const MAX_BYTES = 8 * 1024 * 1024;
const ROOT = "https://ghcr.io/v2/klh/fleet/supervisor-seed";
const ACCEPT =
	"application/vnd.oci.image.index.v1+json,application/vnd.oci.image.manifest.v1+json";
export async function boundedCommand(
	argv: string[],
	cwd: string,
	timeout = 30_000,
	signal?: AbortSignal,
): Promise<Uint8Array> {
	try {
		const result = await hostProcess(argv, {
			cwd,
			timeoutMs: timeout,
			maxBytes: MAX_BYTES,
			signal,
		});
		if (result.code !== 0 || result.signal) throw new Error("Nonzero command");
		return result.stdout;
	} catch {
		throw new Error(`HOST command failed: ${argv[0]}`);
	}
}
export function registryClient(
	token: (signal?: AbortSignal) => Promise<string>,
	fetcher: Fetcher = fetch,
	options: { timeoutMs?: number } = {},
) {
	const request = async (path: string, method = "GET", body?: Uint8Array) =>
		withDeadline(async (signal, wait) => {
			const initial = new URL(ROOT + path);
			let target = initial;
			const bearer = await wait(token(signal));
			let sendBearer = true;
			const blobRead = method === "GET" && path.startsWith("/blobs/");
			let digest: string | null = null;
			for (let hop = 0; ; hop++) {
				const response = await wait(
					fetcher(target.href, {
						method,
						redirect: "manual",
						signal,
						headers: {
							...(sendBearer ? { Authorization: `Bearer ${bearer}` } : {}),
							Accept: ACCEPT,
							...(body
								? { "Content-Type": "application/vnd.oci.image.index.v1+json" }
								: {}),
						},
						...(body ? { body: new Uint8Array(body).buffer } : {}),
					}).catch(() => {
						throw Error("Registry metadata network request failed");
					}),
				);
				const observed = response.headers.get("docker-content-digest");
				if (observed) {
					if (digest && digest !== observed)
						throw Error("Registry redirect digest header mismatch");
					digest = observed;
				}
				if ([301, 302, 303, 307, 308].includes(response.status)) {
					void response.body?.cancel().catch(() => {});
					if (!blobRead || hop >= 3)
						throw Error("Registry redirect forbidden or hop bound reached");
					const location = response.headers.get("location");
					try {
						if (!location || location.length > 8192) throw Error();
						const next = new URL(location, target);
						if (
							next.protocol !== "https:" ||
							next.username ||
							next.password ||
							next.port ||
							next.hash ||
							!["ghcr.io", "pkg-containers.githubusercontent.com"].includes(
								next.hostname,
							) ||
							(next.hostname === "ghcr.io" &&
								next.pathname !== initial.pathname)
						)
							throw Error();
						if (next.origin !== initial.origin) sendBearer = false;
						target = next;
					} catch {
						throw Error("Registry blob redirect refused");
					}
					continue;
				}
				const bytes = await boundedBody(response, MAX_BYTES, wait);
				return { status: response.status, bytes, digest };
			}
		}, options.timeoutMs ?? 30_000);
	const absent = (status: number, bytes: Uint8Array) => {
		if (status !== 404) return false;
		const parsed = z
			.object({ errors: z.array(z.object({ code: z.string() })).min(1) })
			.parse(parseJson(bytes));
		return parsed.errors.every((error) => error.code === "MANIFEST_UNKNOWN");
	};
	const checked = (result: Awaited<ReturnType<typeof request>>) => {
		if (result.status < 200 || result.status >= 300)
			throw new Error(`GHCR HTTP ${result.status}`);
		if (result.digest && result.digest !== hash(result.bytes))
			throw new Error("GHCR digest header mismatch");
		return result.bytes;
	};
	return {
		resolve: async (tag: string) => {
			if (
				!tag.startsWith(`${REPOSITORY}:`) ||
				!/^[\w.-]+$/.test(tag.slice(REPOSITORY.length + 1))
			)
				throw new Error("Foreign registry reference");
			const result = await request(
				`/manifests/${encodeURIComponent(tag.slice(REPOSITORY.length + 1))}`,
			);
			if (absent(result.status, result.bytes)) return null;
			return hash(checked(result));
		},
		read: async (rawDigest: string) => {
			const digest = DigestSchema.parse(rawDigest);
			let result = await request(`/manifests/${digest}`);
			if (absent(result.status, result.bytes))
				result = await request(`/blobs/${digest}`);
			const bytes = checked(result);
			if (hash(bytes) !== digest)
				throw new Error("GHCR content digest mismatch");
			return bytes;
		},
		promote: async (tag: string, bytes: Uint8Array) => {
			if (
				!tag.startsWith(`${REPOSITORY}:`) ||
				!/^[\w.-]+$/.test(tag.slice(REPOSITORY.length + 1))
			)
				throw new Error("Foreign registry reference");
			const result = await request(
				`/manifests/${encodeURIComponent(tag.slice(REPOSITORY.length + 1))}`,
				"PUT",
				bytes,
			);
			if (result.status !== 201 || result.digest !== hash(bytes))
				throw new Error("GHCR exact-index promotion failed");
		},
	};
}
export async function productionDriver(
	repository: string,
	fetcher: Fetcher = fetch,
	deps: { command?: typeof boundedCommand; timeoutMs?: number } = {},
): Promise<ReleaseDriver> {
	const run = deps.command ?? boundedCommand;
	let bearer: { value: string; expires: number } | undefined;
	const token = async (parentSignal?: AbortSignal) => {
		parentSignal?.throwIfAborted();
		if (bearer && Date.now() < bearer.expires) return bearer.value;
		try {
			return await withDeadline(
				async (signal, wait) => {
					const login = z
						.object({ login: z.string().min(1).max(100) })
						.parse(
							parseJson(
								await wait(
									run(["gh", "api", "/user"], repository, 30_000, signal),
								),
							),
						).login;
					const secret = new TextDecoder("utf-8", { fatal: true })
						.decode(
							await wait(
								run(
									["gh", "auth", "token", "--hostname", "github.com"],
									repository,
									30_000,
									signal,
								),
							),
						)
						.trim();
					if (!secret) throw new Error("Existing GH authentication required");
					const response = await wait(
						fetcher(
							"https://ghcr.io/token?service=ghcr.io&scope=repository:klh/fleet/supervisor-seed:pull,push",
							{
								redirect: "error",
								signal,
								headers: {
									Authorization:
										"Basic " +
										Buffer.from(`${login}:${secret}`).toString("base64"),
								},
							},
						).catch(() => {
							throw Error("Registry metadata network request failed");
						}),
					);
					if (!response.ok) throw new Error("GHCR token refused");
					const raw = await boundedBody(response, 64 * 1024, wait);
					const data = z
						.object({
							token: z.string().min(1).max(32768),
							expires_in: z.number().positive().optional(),
						})
						.parse(parseJson(raw));
					bearer = {
						value: data.token,
						expires: Date.now() + Math.min(data.expires_in ?? 60, 60) * 500,
					};
					return data.token;
				},
				deps.timeoutMs ?? 30_000,
				parentSignal,
			);
		} catch {
			throw new Error("GHCR token acquisition refused or failed");
		}
	};
	const client = registryClient(token, fetcher, { timeoutMs: deps.timeoutMs });
	let pinnedPublisher: PublisherIdentity | undefined;
	const audit = async () => {
		const current = await publisherIdentity(repository, (argv, cwd) =>
			run([...argv], cwd),
		);
		if (
			pinnedPublisher &&
			JSON.stringify(pinnedPublisher) !== JSON.stringify(current)
		)
			throw Error("Publisher changed during operation");
		pinnedPublisher = current;
		return current;
	};
	return {
		...client,
		publisher: audit,
		imageMetadata: (source, recipe) =>
			imageCreated(source, recipe, repository, (argv, cwd) =>
				run([...argv], cwd, 30_000),
			),
		promote: async (tag, bytes) => {
			await audit();
			await client.promote(tag, bytes);
		},
		metadata: async () => readPackageMetadata(gitHubApi(repository)),
		stage: async (source, recipe) => {
			await audit();
			const contract = await run(
				[
					"git",
					"--no-replace-objects",
					"show",
					`${recipe}:packages/suspenders/deploy/host/contract.ts`,
				],
				repository,
			);
			const localContract = new Uint8Array(
				await Bun.file(
					new URL("../contract.ts", import.meta.url),
				).arrayBuffer(),
			);
			if (hash(contract) !== hash(localContract))
				throw Error("Image recipe contract is incompatible with publisher");
			const outputs = new Map<string, Uint8Array>();
			const staged = await producerStage(repository, async (argv, cwd) => {
				const command =
					argv[0] === "git" && argv[1] !== "--no-replace-objects"
						? [argv[0], "--no-replace-objects", ...argv.slice(1)]
						: [...argv];
				const bytes = await run(command, cwd, 120_000);
				const operation = argv[1] === "--no-replace-objects" ? 2 : 1;
				if (
					argv[0] === "git" &&
					argv[operation] === "show" &&
					argv[operation + 1]?.startsWith(`${recipe}:`)
				)
					outputs.set(argv[operation + 1].slice(recipe.length + 1), bytes);
				return bytes;
			})(source, recipe);
			try {
				if (outputs.size !== 5)
					throw Error("Exact five committed recipe files required");
				const recipeFiles = [];
				for (const [gitPath, expected] of outputs) {
					const name = basename(gitPath);
					if (
						![
							"Dockerfile",
							"bundle.ts",
							"contract.ts",
							"health.ts",
							"probe.ts",
						].includes(name)
					)
						throw Error("Unexpected staged recipe file");
					const path = name === "Dockerfile" ? name : `recipe/${name}`;
					const actual = new Uint8Array(
						await Bun.file(join(staged.context, path)).arrayBuffer(),
					);
					if (hash(actual) !== hash(expected))
						throw Error("Staged recipe bytes differ from exact Git blob");
					recipeFiles.push({ path, gitPath, sha256: hash(actual).slice(7) });
				}
				recipeFiles.sort((a, b) => a.path.localeCompare(b.path));
				return { ...staged, recipeFiles };
			} catch (error) {
				await staged.clean();
				throw error;
			}
		},
		build: async (argv, cwd) => {
			await audit();
			await run(argv, cwd, 20 * 60 * 1000);
		},
	};
}
