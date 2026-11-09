import { ZodError, z } from "zod";
import { readWireJson } from "./wire.ts";

const IdentitySchema = z.object({
	authenticated: z.literal(true),
	kind: z.enum(["root", "api_key", "jwt", "sso"]),
	key_id: z.string().min(1).max(200),
	team: z.string().nullable(),
	actor: z.string().nullable(),
	scopes: z.array(z.string().max(300)).max(200),
});
export type RunnerIdentity = { keyId: string; scopes: string[]; kind: string };
type Fetch = (url: string | URL, init?: RequestInit) => Promise<Response>;

/** Resolve each request independently: no positive cache across revocation. */
export function createRunnerIdentity(deps: { baseUrl: string; fetch?: Fetch }) {
	const endpoint = new URL("/v1/fleet/whoami", deps.baseUrl);
	if (
		endpoint.username ||
		endpoint.password ||
		!["http:", "https:"].includes(endpoint.protocol)
	)
		throw new Error("runner.invalid_identity_endpoint");
	if (
		endpoint.protocol === "http:" &&
		!["localhost", "127.0.0.1", "[::1]"].includes(endpoint.hostname)
	)
		throw new Error("runner.identity_requires_tls");
	return async (request: Request): Promise<RunnerIdentity> => {
		const authorization = request.headers.get("authorization");
		if (
			!authorization ||
			!/^Bearer [A-Za-z0-9._~-]{1,4096}$/.test(authorization)
		)
			throw new Error("runner.unauthorized");
		try {
			const response = await (deps.fetch ?? fetch)(endpoint, {
				headers: { authorization },
				redirect: "error",
				signal: AbortSignal.timeout(3_000),
			});
			if (!response.ok) {
				await response.body?.cancel();
				throw new Error(
					response.status === 401 || response.status === 403
						? "runner.unauthorized"
						: "runner.identity_unavailable",
				);
			}
			const identity = IdentitySchema.parse(
				await readWireJson(response, 16_384),
			);
			return {
				keyId: identity.key_id,
				kind: identity.kind,
				scopes: identity.scopes,
			};
		} catch (error) {
			if (
				error instanceof ZodError ||
				(error instanceof Error && error.message === "runner.unauthorized")
			)
				throw new Error("runner.unauthorized");
			throw new Error("runner.identity_unavailable");
		}
	};
}
