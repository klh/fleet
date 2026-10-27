// test/w1221-sink-tier.test.ts — W1221: the tier manifest carries the
// knowledge-sink block only when the sink conf resolves (SUSPENDERS_KNOWLEDGE_SINK_URL).
import { describe, expect, test } from "bun:test";
import { emitTierManifest, knowledgeSinkBlock } from "../bin/registry-emit.ts";

const withoutSinkEnv = (fn: () => void): void => {
	const prev = process.env.SUSPENDERS_KNOWLEDGE_SINK_URL;
	delete process.env.SUSPENDERS_KNOWLEDGE_SINK_URL;
	try {
		fn();
	} finally {
		if (prev === undefined) delete process.env.SUSPENDERS_KNOWLEDGE_SINK_URL;
		else process.env.SUSPENDERS_KNOWLEDGE_SINK_URL = prev;
	}
};

describe("tier manifest knowledge block (W1221)", () => {
	test("absent url → null, manifest carries no knowledge key", () => {
		withoutSinkEnv(() => {
			expect(knowledgeSinkBlock({} as NodeJS.ProcessEnv)).toBeNull();
			const doc = JSON.parse(emitTierManifest()) as { knowledge?: unknown };
			expect(doc.knowledge).toBeUndefined();
		});
	});
	test("configured url → block with faces + scopes", () => {
		const b = knowledgeSinkBlock({
			SUSPENDERS_KNOWLEDGE_SINK_URL: "https://nas.local:7802",
		} as NodeJS.ProcessEnv) as { url: string; faces: Record<string, string> };
		expect(b.url).toBe("https://nas.local:7802");
		expect(b.faces.query).toContain("/knowledge/query");
		expect(b.faces.sql).toContain("/knowledge/sql");
		expect(b.faces.search).toContain("/search");
	});
});
