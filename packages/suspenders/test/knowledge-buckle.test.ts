import { describe, expect, test } from "bun:test";
import {
	chmodSync,
	mkdirSync,
	mkdtempSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { knowledgeBuckleRoute } from "../hooks/lib/knowledge-buckle.ts";

describe("knowledge Buckle credential", () => {
	test("reads only a private machine-local config", () => {
		const home = mkdtempSync(join(tmpdir(), "knowledge-buckle-"));
		try {
			const dir = join(home, ".claude/local-llm");
			mkdirSync(dir, { recursive: true });
			const path = join(dir, "knowledge-buckle.json");
			writeFileSync(
				path,
				JSON.stringify({
					url: "http://127.0.0.1:4101",
					token: "bksk_proxy_test",
				}),
			);
			chmodSync(path, 0o644);
			expect(() => knowledgeBuckleRoute({ HOME: home })).toThrow("mode 0600");
			chmodSync(path, 0o600);
			const route = knowledgeBuckleRoute({ HOME: home });
			expect(route.front.href).toBe("http://127.0.0.1:4101/");
			expect(route.token).toBe("bksk_proxy_test");
		} finally {
			rmSync(home, { recursive: true, force: true });
		}
	});

	test("rejects incomplete or unsafe environment routes", () => {
		expect(() =>
			knowledgeBuckleRoute({ SUSPENDERS_BUCKLE_URL: "http://127.0.0.1:4101" }),
		).toThrow("together");
		expect(() =>
			knowledgeBuckleRoute({
				SUSPENDERS_BUCKLE_URL: "http://127.0.0.1:4101",
				SUSPENDERS_BUCKLE_TOKEN: "root-key",
			}),
		).toThrow("scoped");
		expect(() =>
			knowledgeBuckleRoute({
				SUSPENDERS_BUCKLE_URL: "http://user:pass@127.0.0.1:4101",
				SUSPENDERS_BUCKLE_TOKEN: "bksk_proxy_test",
			}),
		).toThrow("invalid");
	});
});
