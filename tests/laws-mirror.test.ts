// laws-mirror.test.ts — W266.3: the laws.md mirror is CI-enforced, not
// honor-system. Four checks over packages/speedy/docs/laws.md:
// (1) every section cites a Source line; (2) every cited path exists and
// every §anchor resolves — a #heading OR a bold lead in the cited file;
// citations with no path token must declare themselves "external";
// (3) coverage: every root AGENTS.md §Laws bold lead has a mirror section;
// (4) teeth: the checks demand a real mirror (≥15 sections, ≥10 sources).
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");
const LAWS = readFileSync(join(ROOT, "packages/speedy/docs/laws.md"), "utf8");
const ROOT_AGENTS = readFileSync(join(ROOT, "AGENTS.md"), "utf8");

const norm = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]/g, "");

// sections = "## Heading" + body up to the next "## "
const sections = LAWS.split(/^## /m).slice(1);
const headingOf = (s: string): string => s.split("\n")[0].trim();
const sourceOf = (s: string): string | null =>
	s.split("\n").find((l) => l.startsWith("Source: ")) ?? null;

// anchor targets of a cited file: #headings AND bold leads (the root
// AGENTS.md laws are bold leads, not headings)
const targets = (text: string): string[] => [
	...[...text.matchAll(/^#{1,6} (.+)$/gm)].map((m) => m[1].trim()),
	...[...text.matchAll(/^- \*\*(.+?)\*\*/gm)].map((m) => m[1].trim()),
];

// path tokens in a citation grammar segment
const TOKEN = /[A-Za-z0-9_][A-Za-z0-9_./-]*\.(md|ts|sh|yaml|json)(?![\w.-])/g;
const anchorOf = (seg: string): string | null => {
	const i = seg.indexOf("§");
	return i >= 0
		? seg
				.slice(i + 1)
				.replace(/[.\s]+$/, "")
				.trim()
		: null;
};

describe("laws.md mirror", () => {
	test("teeth: the mirror is real, not a stub", () => {
		expect(sections.length).toBeGreaterThanOrEqual(15);
		expect(sections.filter((s) => sourceOf(s)).length).toBeGreaterThanOrEqual(
			10,
		);
	});

	test("every section cites a Source line", () => {
		const missing = sections.filter((s) => !sourceOf(s));
		expect(missing.map(headingOf)).toEqual([]);
	});

	test("cited paths exist and every §anchor resolves", () => {
		for (const sec of sections) {
			const source = sourceOf(sec);
			if (!source) continue;
			const segs = source
				.replace(/^Source: /, "")
				.split(";")
				.map((x) => x.trim())
				.filter(Boolean);
			for (const seg of segs) {
				const tokens = [...seg.matchAll(TOKEN)].map((m) => m[0]);
				if (tokens.length === 0) {
					expect(
						seg.toLowerCase().includes("external"),
						`non-external citation without a resolvable path: ${seg}`,
					).toBe(true);
					continue;
				}
				const anchor = anchorOf(seg);
				for (const path of tokens) {
					const pool = targets(readFileSync(join(ROOT, path), "utf8")).map(
						norm,
					);
					if (anchor)
						expect(
							pool.includes(norm(anchor)),
							`anchor "${anchor}" does not resolve in ${path}`,
						).toBe(true);
				}
			}
		}
	});

	test("coverage: every fleet-wide law has a mirror section", () => {
		const leads = targets(ROOT_AGENTS).filter((t) =>
			ROOT_AGENTS.includes(`- **${t}**`),
		);
		const mirrored = sections.map(headingOf).map(norm);
		const gaps = leads.filter((l) => !mirrored.includes(norm(l)));
		expect(gaps).toEqual([]);
	});
});
