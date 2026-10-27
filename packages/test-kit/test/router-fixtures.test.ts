// test/router-fixtures.test.ts — the W1135.1.5 fold: candidateRow keeps the
// affinity row() semantics (defaults, overrides, seq-unique ids), poolOf is
// the entries variant verbatim, poolOfUrl is the url variant parameterized
// by group+dialect, sseHeaders/enc are the per-file consts.
import { describe, expect, test } from "bun:test";
import {
	candidateRow,
	poolOf,
	poolOfUrl,
	sseEnc,
	sseHeaders,
} from "../src/router-fixtures.ts";

describe("candidateRow", () => {
	test("defaults verbatim (incl. the seq double-increment: id port, then +1)", () => {
		const r = candidateRow();
		expect(r.candidate_id).toBe("h:9000:m");
		expect(r.port).toBe(9001);
		expect(r.dep.url).toBe("http://h:9001");
		expect(r.kind).toBe("local");
		expect(r.dialect).toBe("anthropic");
		expect(r.healthy).toBe(true);
	});
	test("overrides apply, ids stay unique across calls", () => {
		const a = candidateRow({ group: "x", healthy: false });
		const b = candidateRow();
		expect(a.group).toBe("x");
		expect(a.healthy).toBe(false);
		expect(b.candidate_id).not.toBe(a.candidate_id);
	});
});

describe("poolOf", () => {
	test("entries variant: groups + deployments, unknown group empty", () => {
		const p = poolOf([["g1", ["http://a:1", "http://a:2"]]]);
		expect(p.groups()).toEqual(["g1"]);
		expect(p.deployments("g1")).toEqual([
			{ group: "g1", url: "http://a:1", dialect: "openai" },
			{ group: "g1", url: "http://a:2", dialect: "openai" },
		]);
		expect(p.deployments("nope")).toEqual([]);
	});
});

describe("poolOfUrl", () => {
	test("defaults are the audited copy's literals", () => {
		const p = poolOfUrl("http://u:9");
		expect(p.groups()).toEqual(["claude-sonnet-5"]);
		expect(p.deployments("claude-sonnet-5")).toEqual([
			{ group: "claude-sonnet-5", url: "http://u:9", dialect: "anthropic" },
		]);
	});
	test("group + dialect parameterized", () => {
		const p = poolOfUrl("http://u:9", { group: "g", dialect: "openai" });
		expect(p.groups()).toEqual(["g"]);
		expect(p.deployments("g")[0]?.dialect).toBe("openai");
	});
});

describe("sse consts", () => {
	test("sseHeaders is the event-stream content type; sseEnc is an encoder", () => {
		expect(sseHeaders).toEqual({ "content-type": "text/event-stream" });
		expect(sseEnc.encode("x").length).toBe(1);
	});
});
