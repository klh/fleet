import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readBeltTrace } from "../src/trace-log.ts";

test("Belt connector returns only bounded diagnostic fields for one trace", () => {
	const dir = mkdtempSync(join(tmpdir(), "belt-trace-"));
	const path = join(dir, "routing.log");
	const id = "a".repeat(32);
	try {
		writeFileSync(
			path,
			[
				JSON.stringify({
					ts: "2026-10-21T11:00:00.000Z",
					event: "upstream_attempt",
					trace_id: id,
					request_id: "req-1",
					attempt: 2,
					hop: "litellm",
					port: 4100,
					status: 500,
					duration_ms: 210,
					failure_kind: "http",
					upstream_call_id: "call-1",
					prompt_sha: "private-fingerprint",
					note: "secret request text",
				}),
				JSON.stringify({ event: "upstream_attempt", trace_id: "b".repeat(32) }),
				"{torn",
				"",
			].join("\n"),
		);
		const read = readBeltTrace(path, id);
		expect(read.status).toBe("ok");
		expect(read.attempts).toHaveLength(1);
		expect(read.attempts[0]).toMatchObject({
			source: "belt",
			trace_id: id,
			ordinal: 2,
			status: 500,
			upstream_call_id: "call-1",
		});
		expect(JSON.stringify(read)).not.toContain("secret");
		expect(JSON.stringify(read)).not.toContain("private-fingerprint");
		expect(readBeltTrace(path, "bad").status).toBe("unavailable");
		expect(readBeltTrace(join(dir, "missing"), id).status).toBe("unavailable");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
