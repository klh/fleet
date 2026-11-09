import {
	adminKey,
	hubCredential,
	mintLaneKey,
	revokeLaneKey,
} from "@klh/suspenders/hooks/lib/lanes/lane-auth.ts";

/** Scoped proxy keys, never raw admin credentials in model requests or output. */
export async function withRouteKey<T>(
	front: string,
	hub: string | null,
	job: string,
	action: (key: string) => Promise<T>,
	fetchFn: typeof fetch = fetch,
) {
	const admin = hub ? hubCredential(hub) : adminKey();
	if (!admin) throw new Error("missing configured route admin credential");
	// The shared helper accepts fetch injection; refuse redirects on admin calls too.
	const guardedFetch = ((input, init) =>
		fetchFn(input, { ...init, redirect: "error" })) as typeof fetch;
	const minted = await mintLaneKey(job, admin, guardedFetch, front);
	if (!minted) throw new Error("scoped route key mint refused");
	let result: T;
	let revoked = false;
	try {
		result = await action(minted.key);
	} finally {
		revoked = await revokeLaneKey(minted.keyId, admin, guardedFetch, front);
		if (!revoked)
			console.error(`route benchmark key cleanup failed: ${minted.keyId}`);
	}
	return { result, revoked };
}
