import { createHash } from "node:crypto";
import {
	fetchCatalogWithKey,
	type CatalogKind,
	type CatalogListing,
} from "./hub-catalog-fetch.ts";

type Target = {
	kind: CatalogKind;
	source: string;
	headers: Record<string, string>;
	auth?: "anthropic";
	maxBytes?: number;
};
export type CatalogObservation = CatalogListing & {
	lastGoodObservedAt?: string;
};
const cache = new Map<
	string,
	{ listing: Extract<CatalogListing, { state: "listed" }>; checkedAt: number }
>();

/** Short process-local cache, credential-bound. Last-good identity is diagnostic only on failure. */
export async function cachedConnectionCatalog(
	target: Target,
	key: string | undefined,
	fetcher: typeof fetch,
	now = Date.now(),
): Promise<CatalogObservation> {
	const identity = createHash("sha256")
		.update(JSON.stringify({ target, key }))
		.digest("hex");
	const previous = cache.get(identity);
	if (
		previous &&
		now >= previous.checkedAt &&
		now - previous.checkedAt < 60_000
	)
		return previous.listing;
	const listing = await fetchCatalogWithKey(target, key, fetcher);
	if (listing.state === "listed") {
		if (cache.size >= 256) cache.delete(cache.keys().next().value ?? "");
		cache.set(identity, { listing, checkedAt: now });
		return listing;
	}
	return {
		...listing,
		...(previous ? { lastGoodObservedAt: previous.listing.observedAt } : {}),
	};
}
