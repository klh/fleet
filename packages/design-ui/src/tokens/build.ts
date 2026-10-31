#!/usr/bin/env bun
// tokens/build.ts — W2269.1.1: the token build face. Reads the JSON sources
// (primitives + semantic + themes) and emits:
//   dist/tokens.css        :root custom properties + [data-theme] overrides
//   dist/tokens.ts         the typed module components import
//   dist/themes/<t>.css    per-theme override files
// and runs the WCAG AA contrast check over every text/surface pair in every
// theme — a failing pair fails the build (exit 1), never a silent ship.
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const HERE = import.meta.dir;
const DIST = join(HERE, "dist");

type TokenMap = Record<string, string>;

// one nesting level for primitives groups (color/space/type); semantic
// files are flat
const readMap = (path: string): TokenMap => {
	const raw = JSON.parse(readFileSync(path, "utf8"));
	return Object.values(raw).some((v) => typeof v === "object")
		? Object.fromEntries(
				Object.values(raw).flatMap((v) =>
					typeof v === "object" ? Object.entries(v) : [],
				),
			)
		: raw;
};

// semantic color role → CSS custom property name.
// board-* keys keep their verbatim page names (--board-*); focus-ring-*
// keys keep the --klh- namespace without the color segment; everything
// else lands in the --klh-c-* color namespace.
const semanticName = (key: string): string =>
	key.startsWith("board-")
		? `--${key}`
		: `--klh-${key.startsWith("focus-ring") ? "" : "c-"}${key}`;

// primitives → custom property namespace by shape: type scale/tracks/stacks,
// motion durations, bare numbers = the space scale, everything else radius.
const primName = (key: string): string => {
	if (
		key.startsWith("size-") ||
		key.startsWith("track-") ||
		key.endsWith("stack")
	)
		return `--klh-typo-${key}`;
	if (key.endsWith("ms")) return `--klh-motion-${key}`;
	if (/^[0-9]/.test(key)) return `--klh-space-${key}`;
	return `--klh-radius-${key}`;
};

const readThemes = (): Map<string, TokenMap> => {
	const dir = join(HERE, "themes");
	return new Map(
		readdirSync(dir)
			.filter((f) => f.endsWith(".json"))
			.map((f) => [f.replace(/\.json$/, ""), readMap(join(dir, f))]),
	);
};

const loadCtx = (): {
	primitives: TokenMap;
	semantic: TokenMap;
	themes: Map<string, TokenMap>;
} => {
	const merge = (dir: string): TokenMap =>
		Object.fromEntries(
			readdirSync(dir)
				.filter((f) => f.endsWith(".json"))
				.flatMap((f) => Object.entries(readMap(join(dir, f)))),
		);
	return {
		primitives: merge(join(HERE, "primitives")),
		semantic: merge(join(HERE, "semantic")),
		themes: readThemes(),
	};
};

// WCAG relative luminance + contrast ratio over raw hex values
const lum = (hex: string): number => {
	const v = hex.replace("#", "");
	const part = (s: string): number => {
		const n = Number.parseInt(s, 16) / 255;
		return n <= 0.03928 ? n / 12.92 : ((n + 0.055) / 1.055) ** 2.4;
	};
	return (
		0.2126 * part(v.slice(0, 2)) +
		0.7152 * part(v.slice(2, 4)) +
		0.0722 * part(v.slice(4, 6))
	);
};

const contrast = (fg: string, bg: string): number => {
	const a = lum(fg);
	const b = lum(bg);
	return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
};

interface Pair {
	fg: string;
	bg: string;
	min: number;
	label: string;
}

// The AA matrix: every text/UI pair the fleet ships. Text pairs need 4.5:1
// (AA normal); single-UI-component pairs (accent/focus against the surface
// they sit on) need 3:1 (AA non-text). A pair referencing a token a theme
// failed to override fails loudly — no silent skip.
const PAIRS: readonly Pair[] = [
	{ fg: "ink", bg: "surface", min: 4.5, label: "body text on surface" },
	{
		fg: "ink-muted",
		bg: "surface",
		min: 4.5,
		label: "secondary text on surface",
	},
	{
		fg: "ink-faint",
		bg: "surface",
		min: 4.5,
		label: "tertiary text on surface",
	},
	{ fg: "accent", bg: "surface", min: 3, label: "accent UI on surface" },
	{ fg: "focus", bg: "surface", min: 3, label: "focus UI on surface" },
];

const resolveHex = (
	key: string,
	semantic: TokenMap,
	overrides: TokenMap,
): string => {
	const v = overrides[key] ?? semantic[key];
	if (v === undefined)
		throw new Error(`contrast pair references missing token "${key}"`);
	if (!v.startsWith("#"))
		throw new Error(`contrast pair token "${key}" is not a raw hex: ${v}`);
	return v;
};

const checkAA = (ctx: ReturnType<typeof loadCtx>): void => {
	const failures: string[] = [];
	for (const [theme, overrides] of ctx.themes) {
		for (const p of PAIRS) {
			const fg = resolveHex(p.fg, ctx.semantic, overrides);
			const bg = resolveHex(p.bg, ctx.semantic, overrides);
			const ratio = contrast(fg, bg);
			if (ratio < p.min)
				failures.push(
					`${theme}: ${p.label} ${fg} on ${bg} = ${ratio.toFixed(2)}:1 < ${p.min}:1`,
				);
		}
	}
	if (failures.length) {
		console.error(
			`design-ui tokens: WCAG AA failures:\n${failures.join("\n")}`,
		);
		process.exit(1);
	}
};

const emit = (ctx: ReturnType<typeof loadCtx>): void => {
	mkdirSync(DIST, { recursive: true });
	const banner =
		"/* GENERATED by src/tokens build face — edit the JSON sources, never this file. */\n";
	const rows = (map: TokenMap, name: (k: string) => string): string =>
		Object.entries(map)
			.map(([k, v]) => `\t${name(k)}: ${v};`)
			.sort()
			.join("\n");
	const cssParts = [
		banner,
		":root {\n",
		rows(ctx.primitives, primName),
		"\n",
		rows(ctx.semantic, semanticName),
		"\n}\n",
	];
	mkdirSync(join(DIST, "themes"), { recursive: true });
	for (const [theme, overrides] of ctx.themes) {
		cssParts.push(
			`[data-theme="${theme}"] {\n`,
			rows(overrides, semanticName),
			"\n}\n",
		);
		writeFileSync(
			join(DIST, "themes", `${theme}.css`),
			banner +
				`[data-theme="${theme}"] {\n${rows(overrides, semanticName)}\n}\n`,
		);
	}
	writeFileSync(join(DIST, "tokens.css"), cssParts.join(""));
	const typed = [
		"// GENERATED by src/tokens/build.ts — edit the JSON sources, never this file.\n",
		"// Semantic token names, typed; values are the :root (dark) defaults.\n",
		`export const TOKENS = ${JSON.stringify(
			Object.fromEntries(
				Object.entries(ctx.semantic).map(([k, v]) => [semanticName(k), v]),
			),
			null,
			"\t",
		)} as const;\n`,
		"export type TokenName = keyof typeof TOKENS;\n",
	].join("");
	writeFileSync(join(DIST, "tokens.ts"), typed);
};

const ctx = loadCtx();
checkAA(ctx);
emit(ctx);
console.log(
	`design-ui tokens: emitted tokens.css + tokens.ts + ${ctx.themes.size} theme files; AA check clean`,
);
