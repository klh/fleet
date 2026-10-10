// hooks/lib/ui/icons.ts — W581 canonical monochrome icon set.
// One source of truth for every klh GUI: fine-line stroke SVGs, 24×24 grid,
// stroke="currentColor" — color comes ONLY from CSS `color` (theme tokens),
// never from the icon markup. Surfaces render them via <klh-icon> (Lit) or
// inline the raw strings server-side (theme-style vendoring). Unknown names
// render the fallback dot, never a broken glyph.
//
// Canonical home: klh/suspenders hooks/lib/ui/. Belt/local vendor byte-copy;
// drift tests pin the bytes (docs/ui-kit.md).

export interface IconDef {
	readonly svg: string; // inner SVG (paths), 24×24 coordinates
	readonly label: string; // accessible name
}

const p = (d: string): string =>
	`<path d="${d}" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>`;

// fine-line circle (node/dot)
const c = (cx: number, cy: number, r: number): string =>
	`<circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="currentColor" stroke-width="1.5"/>`;

export const ICONS: Readonly<Record<string, IconDef>> = {
	fleet: {
		svg: `${c(5, 5, 2.4)}${c(19, 8, 2.4)}${c(12, 19, 2.4)}<path d="M6.8 6.6 10.4 17.2M13.6 17.9 17.6 10M7.2 4.6 16.8 7.6" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>`,
		label: "fleet",
	},
	tree: {
		svg: `${c(5, 4.5, 2.2)}${c(5, 19.5, 2.2)}${c(18, 12, 2.2)}<path d="M5 6.8v10.4M5 12h10.7" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>`,
		label: "tree",
	},
	models: {
		svg: `<path d="m12 3 8 4.5-8 4.5-8-4.5L12 3Z" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/><path d="m4 12.5 8 4.5 8-4.5M4 17l8 4.5L20 17" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>`,
		label: "models",
	},
	workflows: {
		svg: `${c(5, 6, 2.4)}${c(19, 6, 2.4)}${c(12, 18, 2.4)}<path d="M7.5 6h9M6 8.2 10.8 16M18 8.2 13.2 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>`,
		label: "workflows",
	},
	metrics: {
		svg: `<path d="M4 4v16h16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/><path d="M8 16v-5M12 16V8M16 16v-8" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>`,
		label: "metrics",
	},
	activity: {
		svg: `<path d="M3 12h4l2.5-6 5 12 2.5-6H21" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>`,
		label: "activity",
	},
	decisions: {
		svg: `<path d="M4 5h16v11H9l-5 4V5Z" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/><path d="M8 9h8M8 12h5" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>`,
		label: "decisions",
	},
	tasks: {
		svg: `<rect x="4" y="4" width="16" height="16" rx="2" fill="none" stroke="currentColor" stroke-width="1.5"/><path d="m8 12 3 3 5-6" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>`,
		label: "tasks",
	},
	lanes: {
		svg: `<rect x="4" y="4" width="4.6" height="16" rx="1.2" fill="none" stroke="currentColor" stroke-width="1.5"/><rect x="9.7" y="4" width="4.6" height="16" rx="1.2" fill="none" stroke="currentColor" stroke-width="1.5"/><rect x="15.4" y="4" width="4.6" height="16" rx="1.2" fill="none" stroke="currentColor" stroke-width="1.5"/>`,
		label: "lanes",
	},
	usage: {
		svg: `<path d="M4 18a8 8 0 1 1 16 0" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/><path d="M12 18 15.5 10" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/><circle cx="12" cy="18" r="1.2" fill="currentColor"/>`,
		label: "usage",
	},
	setup: {
		svg: `<circle cx="12" cy="12" r="3.2"/><path d="M12 2.5v3M12 18.5v3M2.5 12h3M18.5 12h3M5.3 5.3l2.1 2.1M16.6 16.6l2.1 2.1M18.7 5.3l-2.1 2.1M7.4 16.6l-2.1 2.1"/>`,
		label: "setup",
	},
	hub: {
		svg: `<circle cx="12" cy="12" r="2.6" fill="currentColor"/><circle cx="12" cy="12" r="7.5" fill="none" stroke="currentColor" stroke-width="1.5"/><circle cx="12" cy="12" r="10.2" fill="none" stroke="currentColor" stroke-width="1.5"/>`,
		label: "hub",
	},
	cloud: {
		svg: `<path d="M7 18a4 4 0 0 1-.6-7.96 5.5 5.5 0 0 1 10.9 1.06A3.6 3.6 0 0 1 17 18H7Z" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/>`,
		label: "cloud",
	},
	chevron: {
		svg: `<path d="m9 5 7 7-7 7" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>`,
		label: "expand",
	},
};

// unknown name → dot, never a broken img glyph
const DOT = {
	svg: c(12, 12, 4),
	label: "unknown icon",
} satisfies IconDef;

export const icon = (name: string, size = 16): string => {
	const def = ICONS[name] ?? DOT;
	return `<svg width="${size}" height="${size}" viewBox="0 0 24 24" aria-hidden="true" focusable="false">${def.svg}</svg>`;
};

export const iconLabel = (name: string): string => (ICONS[name] ?? DOT).label;
