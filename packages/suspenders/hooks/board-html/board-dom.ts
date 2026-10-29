// hooks/board-html/board-dom.ts — the ONE page lookup helper, shared by the
// legacy chunk scope (embedded into CORE via toString(), so it stays
// self-contained: no imports, platform globals only) and the Lit modules
// that read page-level elements (#proj, #usage-data).

export function byId<T extends HTMLElement = HTMLElement>(id: string) {
	return document.getElementById(id) as T | null;
}
