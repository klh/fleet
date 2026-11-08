// hooks/lib/lanes/vision-capability.ts — W2854: the ONE vision-capability
// grammar the dispatch plane reads. Seed data lives in the belt catalog
// (@klh/belt model-capabilities staticInputModalities — the catalog manifest
// row: glm-5.3 = text-only per the verified lesson). Consumers: the lane
// brief (ROUTE VISION clause), the Read gate (image-Read refusal on a
// text-only route), kev-chooses (vision facts ride the typed choice), and
// the dispatch NOTE on a text-only final model.
//
// Doctrine: text-only REFUSES the image Read (the image block would 400 the
// leg and poison provider health — lesson glm53-text-only-image-400);
// vision and unknown never block (unknown never blocks — W1712 parity).
import { staticInputModalities } from "@klh/belt/bin/model-capabilities.ts";

export type VisionCapability = "vision" | "text-only" | "unknown";

/** The lane route's vision capability over a model id (any wire spelling —
 *  provider prefixes normalize). Unknown never claims text-only. */
export const visionCapabilityOf = (
	modelId: string | null | undefined,
): VisionCapability => {
	if (!modelId) return "unknown";
	const row = staticInputModalities(modelId);
	if (!row) return "unknown";
	return row.includes("image") ? "vision" : "text-only";
};

/** Extensions whose Read becomes an image block on the wire (PDFs ride the
 *  document-block path — an unverified claim, out of W2854 scope). */
export const IMAGE_BLOCK_RE =
	/\.(png|jpe?g|gif|webp|bmp|ico|icns|tiff|avif)$/i;

/** The Read-gate refusal for an image Read on a text-only route: null =
 *  allow (route unknown/vision-capable or the file is not an image block). */
export const imageReadDenyReason = (
	path: string,
	model: string | null | undefined,
): string | null => {
	if (!model || !IMAGE_BLOCK_RE.test(path)) return null;
	if (visionCapabilityOf(model) !== "text-only") return null;
	return `read-gate: ${path} is an image and this lane rides ${model}, a TEXT-ONLY route — the image block would 400 the leg, wedge the transcript (400→502 retry loop), and poison shared provider health (W2267.4.1/W2267.5). Cite image evidence textually (rg/ls; an operator can paste a description), or get the route re-pinned to a vision-capable model before reading it.`;
};

/** The brief clause for a text-only route (0–1 lines; absent = no clause —
 *  legacy briefs stay byte-identical). */export const visionBriefLines = (model: string | null | undefined): string[] => {
	if (visionCapabilityOf(model) !== "text-only") return [];
	return [
		`ROUTE VISION: ${model} is TEXT-ONLY — NEVER Read PNG/image files into lane context; the provider 400s image blocks, the poison wedges the lane (400→502 retry loop) AND contaminates provider health so later TEXT requests 503 at queue 0. All verification is text-only: DOM snapshots, computed styles, API payloads; the operator reviews visuals.`,
	];
};

/** W2854 (3): the image-poison wedge shape in a dead lane's log tail — an
 *  invalid-request on an image block followed by the 502 retry loop. Pure:
 *  the caller owns the tail. null = the tail shows no image-poison evidence. */
export const imagePoisonWedge = (tail: string): string | null => {
	const t = tail.toLowerCase();
	const imageBlock =
		/invalid[_ -]?request/.test(t) &&
		/image|base64|media_type|modal/.test(t) &&
		/\b400\b/.test(t);
	if (!imageBlock) return null;
	const retries = (t.match(/\b50[02]\b/g) ?? []).length;
	return `image-poison wedge: an image block 400'd on a text-only route${retries ? ` and the leg retried into ${String(retries)} 5xx responses` : ""} — the transcript carries the block on every continuation, so no resume recovers it; relaunch on clean text context (lesson glm53-text-only-image-400)`;
};
