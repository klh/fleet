import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadUpstreams } from "../src/upstreams.ts";

describe("configured deployment priority", () => {
	test("loads numeric priority and refuses invalid values", () => {
		const dir = mkdtempSync(join(tmpdir(), "buckle-priority-"));
		const path = join(dir, "upstreams.json");
		const write = (priority: unknown) =>
			writeFileSync(
				path,
				JSON.stringify({
					groups: {
						glm: [
							{ url: "http://127.0.0.1:4301", dialect: "openai", priority },
						],
					},
				}),
			);
		try {
			write(0);
			expect(loadUpstreams(path).deployments("glm")[0]?.priority).toBe(0);
			for (const invalid of [-1, 1.5, "0"]) {
				write(invalid);
				expect(() => loadUpstreams(path)).toThrow(/group "glm".*priority/);
			}
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
