// hooks/board-html/core-feeds.ts — feed-store embed + the one page poller (W2269.1.3 decompose).
// String.raw keeps bun's non-ASCII escaping byte-identical to HEAD (W157);
// substitutions still evaluate here — this module imports FeedStore.
import { FeedStore } from "./feed-store.ts";

// biome-ignore lint/complexity/noUselessStringRaw: byte-compat (W157)
export const CORE_FEEDS = String.raw`// --- the ONE page-wide feed store (feed-store.ts; the Lit mediator adopts it) ---
var FeedStore = ${FeedStore.toString()};
`;
