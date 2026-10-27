// board-drop-files.test.ts — W858.8 orchestrator file attachments: upload
// (bounded, typed), capability-URL retrieval/auth, expiry cleanup, and the
// orchestrate attachment-ref validation. Rides the standard board fixture
// (scratch HOME + spawned board); unit-level blocks pin the pure helpers.
import { expect, test } from "@playwright/test";
import { existsSync, mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { boardFixture } from "./helpers/board-fixture.ts";
import {
	composeGoalAttachments,
	purgeExpiredDrops,
	resolveDropRef,
	sanitizeDropName,
	storeDrop,
} from "../hooks/board/drop-files.ts";

const f = await boardFixture(0, test.afterAll);
const store = () => join(f.HOME, ".cache", "claude-governor", "drop-files");

// multipart upload helper — the browser-shaped path (bytes on the wire,
// never a path); returns { status, json }
function postFiles(
	files: { name: string; bytes: Uint8Array; type?: string }[],
	extra: Record<string, string> = {},
) {
	const fd = new FormData();
	for (const x of files)
		fd.append(
			"files",
			new File([x.bytes], x.name, { type: x.type ?? "text/plain" }),
		);
	return fetch(`${f.BASE}/api/orchestrate/files`, {
		method: "POST",
		headers: { "x-klh-write-token": f.TOKEN, ...extra },
		body: fd,
	}).then(async (r) => ({ status: r.status, json: await r.json() }));
}

test.describe("board drop files: upload → exact refs + retrieval", () => {
	test("upload, private modes, meta + byte-exact GET", async () => {
		const bytes = new TextEncoder().encode("# notes\nhello fleet\n");
		const up = await postFiles([
			{ name: "notes.md", bytes, type: "text/markdown" },
		]);
		expect(up.status).toBe(200);
		const file = (up.json as { files?: Record<string, unknown>[] }).files?.[0];
		expect(file?.url).toMatch(
			/^http:\/\/127\.0\.0\.1:\d+\/api\/files\/[0-9a-f]{16}\?k=[0-9a-f]{32}$/,
		);
		expect(file?.name).toBe("notes.md");
		expect(file?.sha256).toBe(createHash("sha256").update(bytes).digest("hex"));
		const bin = join(store(), `${file?.id}.bin`);
		expect(statSync(bin).mode & 0o777).toBe(0o600);
		const got = await fetch(String(file?.url));
		expect(got.status).toBe(200);
		expect(await got.text()).toBe("# notes\nhello fleet\n");
		expect(got.headers.get("content-disposition")).toContain("attachment");
		expect(got.headers.get("x-content-type-options")).toBe("nosniff");
		const meta = await fetch(`${file?.url}&meta=1`);
		expect(meta.status).toBe(200);
		const mj = (await meta.json()) as { file?: Record<string, unknown> };
		expect(mj.file?.name).toBe("notes.md");
		expect(mj.file?.type).toBe("text/markdown");
		expect(mj.file?.size).toBe(bytes.length);
		expect(mj.file?.expiresAt).toBeGreaterThan(Date.now());
		expect(mj.file?.secret).toBeUndefined();
	});
});

test.describe("board drop files: capability auth", () => {
	test("missing/wrong secret + unknown id + method guard", async () => {
		const up = await postFiles([
			{ name: "secret-plan.txt", bytes: new TextEncoder().encode("x") },
		]);
		const url = String(
			(up.json as { files?: { url?: string }[] }).files?.[0]?.url,
		);
		expect((await fetch(url.replace(/k=.*$/, "k="))).status).toBe(404);
		expect((await fetch(url.replace(/k=.*$/, "k=deadbeef"))).status).toBe(404);
		expect(
			(await fetch(`${f.BASE}/api/files/0123456789abcdef?k=x`)).status,
		).toBe(404);
		expect(
			(
				await fetch(url, {
					method: "POST",
					headers: { "x-klh-write-token": f.TOKEN },
				})
			).status,
		).toBe(405);
	});
});

test.describe("board drop files: limits", () => {
	test("size cap answers 413, disallowed type answers 415", async () => {
		const big = new Uint8Array(4 * 1024 * 1024 + 1);
		const over = await postFiles([{ name: "big.md", bytes: big }]);
		expect(over.status).toBe(413);
		const exe = await postFiles([
			{ name: "evil.exe", bytes: new TextEncoder().encode("MZ") },
		]);
		expect(exe.status).toBe(415);
		const nine = Array.from({ length: 9 }, (_, i) => ({
			name: `f${i}.txt`,
			bytes: new TextEncoder().encode(String(i)),
		}));
		expect((await postFiles(nine)).status).toBe(400);
		const jsonPost = await fetch(`${f.BASE}/api/orchestrate/files`, {
			method: "POST",
			headers: {
				"content-type": "application/json",
				"x-klh-write-token": f.TOKEN,
			},
			body: JSON.stringify({}),
		});
		expect(jsonPost.status).toBe(415);
		const noToken = await fetch(`${f.BASE}/api/orchestrate/files`, {
			method: "POST",
			body: new FormData(),
		});
		expect(noToken.status).toBe(403);
		const noTokenDel = await fetch(`${f.BASE}/api/files/0123456789abcdef`, {
			method: "DELETE",
		});
		expect(noTokenDel.status).toBe(403);
	});
});

test.describe("board drop files: expiry cleanup + DELETE", () => {
	test("expired ref: 410, purge-on-touch, then 404", async () => {
		const up = await postFiles([
			{ name: "old.md", bytes: new TextEncoder().encode("stale") },
		]);
		const file = (up.json as { files?: { id: string; url: string }[] })
			.files?.[0] as { id: string; url: string };
		const metaPath = join(store(), `${file.id}.json`);
		const meta = JSON.parse(readFileSync(metaPath, "utf8")) as {
			expiresAt: number;
		};
		meta.expiresAt = Date.now() - 1;
		const { writeFileSync } = await import("node:fs");
		writeFileSync(metaPath, JSON.stringify(meta));
		const got = await fetch(file.url);
		expect(got.status).toBe(410);
		expect(existsSync(join(store(), `${file.id}.bin`))).toBe(false);
		expect((await fetch(file.url)).status).toBe(404);
	});
	test("DELETE removes early (auth-guarded) and cleans the store", async () => {
		const up = await postFiles([
			{ name: "gone.md", bytes: new TextEncoder().encode("bye") },
		]);
		const file = (up.json as { files?: { id: string; url: string }[] })
			.files?.[0] as { id: string; url: string };
		const del = await fetch(file.url, {
			method: "DELETE",
			headers: { "x-klh-write-token": f.TOKEN },
		});
		expect(del.status).toBe(200);
		expect(existsSync(join(store(), `${file.id}.bin`))).toBe(false);
		expect(existsSync(join(store(), `${file.id}.json`))).toBe(false);
		expect((await fetch(file.url)).status).toBe(404);
	});
});

test.describe("board drop files: orchestrate attachment validation", () => {
	test("dead ref = 400 before any LLM call", async () => {
		const r = await f.post("/api/orchestrate", {
			project: f.MY_PROJ,
			goal: "plan with a dead attachment",
			attachments: ["http://127.0.0.1:1/api/files/0123456789abcdef?k=ff"],
		});
		expect(r.status).toBe(400);
		expect(String(r.json.error)).toContain("not resolvable");
	});
});

test.describe("drop-files helpers (unit, SUSPENDERS_DROP_DIR pinned)", () => {
	const UNIT_DIR = mkdtempSync(join(tmpdir(), "suspenders-drops-"));
	const savedDir = process.env.SUSPENDERS_DROP_DIR;
	test.beforeAll(() => {
		process.env.SUSPENDERS_DROP_DIR = UNIT_DIR;
	});
	test.afterAll(() => {
		// bun: assigning undefined materializes the STRING "undefined" — delete
		if (savedDir === undefined) delete process.env.SUSPENDERS_DROP_DIR;
		else process.env.SUSPENDERS_DROP_DIR = savedDir;
	});

	test("sanitize strips path decoration", () => {
		expect(sanitizeDropName("../../etc/passwd")).toBe("passwd");
		expect(sanitizeDropName("a\\b\\notes.md")).toBe("notes.md");
		expect(sanitizeDropName("")).toBe("file");
	});

	test("store → resolveRef roundtrip with private modes + purge", () => {
		const bytes = new TextEncoder().encode("unit bytes");
		const s = storeDrop({
			name: "unit.md",
			type: "text/markdown",
			bytes,
		});
		if (!s.ok) throw new Error("storeDrop failed");
		expect(statSync(join(UNIT_DIR, `${s.meta.id}.bin`)).mode & 0o777).toBe(
			0o600,
		);
		const ref = `http://x/api/files/${s.meta.id}?k=${s.meta.secret}`;
		expect(resolveDropRef(ref).ok).toBe(true);
		expect(resolveDropRef(ref.replace(/k=.*$/, "k=nope")).ok).toBe(false);
		// rewrite the meta to the past → resolve purges the pair
		const metaPath = join(UNIT_DIR, `${s.meta.id}.json`);
		const meta = JSON.parse(readFileSync(metaPath, "utf8")) as {
			expiresAt: number;
		};
		meta.expiresAt = Date.now() - 1;
		const { writeFileSync } = require("node:fs");
		writeFileSync(metaPath, JSON.stringify(meta));
		expect(resolveDropRef(ref).ok).toBe(false);
		expect(existsSync(join(UNIT_DIR, `${s.meta.id}.bin`))).toBe(false);
	});
});

test.describe("drop-files compose (unit)", () => {
	const UNIT_DIR2 = mkdtempSync(join(tmpdir(), "suspenders-drops2-"));
	const saved2 = process.env.SUSPENDERS_DROP_DIR;
	test.beforeAll(() => {
		process.env.SUSPENDERS_DROP_DIR = UNIT_DIR2;
	});
	test.afterAll(() => {
		// bun: assigning undefined materializes the STRING "undefined" — delete
		if (saved2 === undefined) delete process.env.SUSPENDERS_DROP_DIR;
		else process.env.SUSPENDERS_DROP_DIR = saved2;
	});

	test("composeGoalAttachments: live refs append the block, dead ref fails", () => {
		const s = storeDrop({
			name: "ctx.md",
			type: "text/markdown",
			bytes: new TextEncoder().encode("ctx"),
		});
		if (!s.ok) throw new Error("storeDrop failed");
		const ref = `http://x/api/files/${s.meta.id}?k=${s.meta.secret}`;
		const c = composeGoalAttachments("do the thing", [ref]);
		expect(c.ok).toBe(true);
		if (c.ok) {
			expect(c.goal).toContain("ATTACHED FILES");
			expect(c.goal).toContain(`- ctx.md (3 bytes`);
			expect(c.goal).toContain(ref);
		}
		const dead = composeGoalAttachments("do the thing", [
			"http://x/api/files/0123456789abcdef?k=ff",
		]);
		expect(dead.ok).toBe(false);
	});
});