// packages/suspenders/test/report-html.test.ts — W1199 lane report artifacts:
// the generator's strict md-subset → single-file HTML shell (escaping, TOC,
// severity badges, diff tables), artifact persistence, and the board's
// derived-path serving face over a fixture events table.
import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	esc,
	emitReportFromMd,
	renderReportHtml,
	reportArtifactPath,
	reportRecordFor,
	reportRecordMap,
	serveReport,
	writeReportArtifact,
} from "../hooks/lib/report-html.ts";
import {
	attachCloseReport,
	regenReport,
} from "../hooks/lib/work-report-cli.ts";

// migrated events schema (govdb v14 shredded project/work columns)
function fixtureDb(): Database {
	const db = new Database(":memory:");
	db.exec(
		"CREATE TABLE events (id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, source TEXT NOT NULL, kind TEXT NOT NULL, scope TEXT, payload TEXT, target TEXT, project TEXT, work TEXT)",
	);
	// mirror the production shred trigger (govdb v14 events-shred.ts) so
	// emitReportFromMd's INSERT behaves exactly as it does against the live db
	db.exec(
		"CREATE TRIGGER events_shred_ai AFTER INSERT ON events BEGIN UPDATE events SET project = json_extract(NEW.payload, '$.project'), work = json_extract(NEW.payload, '$.work') WHERE id = NEW.id; END",
	);
	return db;
}

function stampReport(
	db: Database,
	project: string,
	id: string,
	sha = "a".repeat(64),
): void {
	db.query(
		"INSERT INTO events (ts, source, kind, scope, payload, target, project, work) VALUES (?, 'work', 'work.report', NULL, ?, NULL, ?, ?)",
	).run(
		Date.now(),
		JSON.stringify({ work: id, project, sha256: sha }),
		project,
		id,
	);
}

describe("esc", () => {
	test("escapes html-significant characters", () => {
		expect(esc(`<a href="x">&'</a>`)).toBe(
			"&lt;a href=&quot;x&quot;&gt;&amp;&#39;&lt;/a&gt;",
		);
	});
});

describe("renderReportHtml", () => {
	const meta = {
		project: "/tmp/repo/.git",
		item: "W1",
		title: "T <script>alert(1)</script>",
		sha: null,
		generatedAt: "2026-10-23T00:00:00Z",
		source: null,
	};

	test("shell escapes the title", () => {
		const html = renderReportHtml(meta, "body text");
		expect(html).toContain("<!DOCTYPE html>");
		expect(html).toContain("T &lt;script&gt;");
		expect(html).not.toContain("<script>");
	});

	test("headings become sections and feed the TOC", () => {
		const html = renderReportHtml(meta, "## Findings\n\ntext\n\n## Next\n");
		expect(html).toContain('<h2 id="s1">');
		expect(html).toContain('<h2 id="s2">Next</h2>');
		expect(html).toContain('<a href="#s1">Findings</a>');
	});
});

describe("markdown subset", () => {
	const meta = {
		project: "/tmp/repo/.git",
		item: "W2",
		title: "T",
		sha: "b".repeat(40),
		generatedAt: "2026-10-23T00:00:00Z",
		source: null,
	};

	test("severity badges and inline code ride list items", () => {
		const html = renderReportHtml(meta, "- [HIGH] leaking `secret` value\n");
		expect(html).toContain('<span class="sev sev-high">HIGH</span>');
		expect(html).toContain("<code>secret</code>");
	});

	test("tables render as data tables with badges in cells", () => {
		const html = renderReportHtml(
			meta,
			"| finding | severity |\n| --- | --- |\n| one | [FAIL] |\n",
		);
		expect(html).toContain('<table class="data">');
		expect(html).toContain("<th>finding</th>");
		expect(html).toContain('<span class="sev sev-fail">FAIL</span>');
	});

	test("diff fences render as +/- diff tables", () => {
		const html = renderReportHtml(
			meta,
			"```diff\n- old line\n+ new line\n```\n",
		);
		expect(html).toContain('<table class="diff">');
		expect(html).toContain('<tr class="ddel">');
		expect(html).toContain('<tr class="dadd">');
	});
});

describe("artifact persistence and serving", () => {
	test("writeReportArtifact writes the derived path with a truthful sha", async () => {
		const root = mkdtempSync(join(tmpdir(), "w1199-"));
		try {
			const project = join(root, "repo", ".git");
			const out = writeReportArtifact({
				project: project,
				item: "W7",
				title: "Pilot",
				markdown: "## A\n\nb\n",
				sha: "c".repeat(40),
			});
			expect(out.path).toBe(reportArtifactPath(project, "W7"));
			expect(out.path.endsWith(".fleet/reports/W7.html")).toBe(true);
			const html = await Bun.file(out.path).text();
			expect(html).toContain("Pilot");
			expect(out.sha256).toHaveLength(64);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	test("serveReport serves the derived artifact and nulls without a record", () => {
		const root = mkdtempSync(join(tmpdir(), "w1199s-"));
		try {
			const project = join(root, "repo", ".git");
			const db = fixtureDb();
			expect(serveReport(db, project, "W9")).toBeNull(); // no event yet
			writeReportArtifact({
				project: project,
				item: "W9",
				title: "Served",
				markdown: "body",
			});
			stampReport(db, project, "W9");
			const res = serveReport(db, project, "W9");
			expect(res).not.toBeNull();
			expect(res?.headers.get("content-type")).toBe("text/html; charset=utf-8");
			expect(res?.headers.get("x-content-type-options")).toBe("nosniff");
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	test("event lookups key on project and item", () => {
		const db = fixtureDb();
		stampReport(db, "/tmp/r1/.git", "W3", "d".repeat(64));
		stampReport(db, "/tmp/r2/.git", "W3", "e".repeat(64));
		const one = reportRecordFor(db, "/tmp/r1/.git", "W3");
		expect(one?.sha256.startsWith("d")).toBe(true);
		expect(reportRecordFor(db, "/tmp/r3/.git", "W3")).toBeNull();
		const map = reportRecordMap(db, null);
		expect(map.size).toBe(2);
		const scoped = reportRecordMap(db, "/tmp/r1/.git");
		expect(scoped.size).toBe(1);
		expect(scoped.get(`/tmp/r1/.git\u0000W3`)?.sha256.startsWith("d")).toBe(
			true,
		);
	});

	test("malformed ids and missing artifacts refuse to serve", () => {
		const db = fixtureDb();
		stampReport(db, "/tmp/r4/.git", "W4");
		expect(serveReport(db, "/tmp/r4/.git", "../escape")).toBeNull();
		expect(serveReport(db, "", "W4")).toBeNull();
		expect(serveReport(db, "/tmp/r4/.git", "W4")).toBeNull(); // event, no file
	});
});

describe("report CLI faces", () => {
	test("close face swallows, regen face is strict", async () => {
		const root = mkdtempSync(join(tmpdir(), "w1199f-"));
		try {
			const project = join(root, "repo", ".git");
			const db = fixtureDb();
			db.exec("CREATE TABLE work_items (project TEXT, id TEXT, scope TEXT)");
			const missing = join(root, "missing.md");
			let swallowed = false;
			await attachCloseReport({
				db,
				project,
				item: "W11",
				title: "T",
				mdPath: missing,
			}).catch(() => {
				swallowed = true;
			});
			expect(swallowed).toBe(false);
			expect(
				regenReport({ db, project, item: "W11", title: "T", mdPath: missing }),
			).rejects.toThrow();
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});

describe("emitReportFromMd", () => {
	test("renders and stamps work.report provenance", async () => {
		const root = mkdtempSync(join(tmpdir(), "w1199e-"));
		try {
			const project = join(root, "repo", ".git");
			const db = fixtureDb();
			db.exec("CREATE TABLE work_items (project TEXT, id TEXT, scope TEXT)");
			db.query(
				"INSERT INTO work_items (project, id, scope) VALUES (?, ?, NULL)",
			).run(project, "W11");
			const md = join(root, "record.md");
			await Bun.write(md, "Some body text");
			const a = await emitReportFromMd({
				db,
				project,
				item: "W11",
				title: "Pilot",
				mdPath: md,
				sha: "f".repeat(40),
			});
			expect(a.path.endsWith(".fleet/reports/W11.html")).toBe(true);
			const row = db
				.query(
					"SELECT project, work, payload FROM events WHERE kind = 'work.report'",
				)
				.get() as {
				project: string;
				work: string;
				payload: string;
			};
			expect(row.project).toBe(project);
			expect(row.work).toBe("W11");
			expect((JSON.parse(row.payload) as { sha256: string }).sha256).toBe(
				a.sha256,
			);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});
