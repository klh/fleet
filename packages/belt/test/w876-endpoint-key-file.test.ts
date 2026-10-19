// test/w876-endpoint-key-file.test.ts — W876: endpointKey falls back to the
// 0600 engine key file when the api_key_env var is absent from the process
// env (the 2026-10-19 :4100 401 mass lane-death: belt-swarm-spawned children
// never had LITELLM_KEY). Precedent is litellm-target.ts loadKeys(): env
// first, then the file. Both inputs are injected — a unit run never touches
// the real runtime home.
import { describe, expect, test } from "bun:test";
import type { RemoteEndpoint } from "../bin/remotes.ts";
import { endpointKey } from "../bin/remotes.ts";

const ep = (extra: Partial<RemoteEndpoint> = {}): RemoteEndpoint => ({
	port: 4100,
	protocol: "openai",
	roles: ["general"],
	...extra,
});

// Stands in for the real ${HOME}/.claude/local-llm/litellm.key read (the
// default reader trims; the injected one returns the post-trim value) and
// captures the requested path so the test can pin the file mapping.
const lastRead: string[] = [];
const read = (path: string): string | undefined => {
	lastRead.push(path);
	if (path.endsWith("/litellm.key")) return "file-key";
	return undefined;
};

describe("W876 endpointKey 0600 file fallback", () => {
	test("inline api_key still wins over env and file", () => {
		expect(
			endpointKey(ep({ api_key: "inline" }), { LITELLM_KEY: "env-key" }, read),
		).toBe("inline");
	});

	test("env var wins over the file (env first)", () => {
		expect(
			endpointKey(
				ep({ api_key_env: "LITELLM_KEY" }),
				{ LITELLM_KEY: "env-key" },
				read,
			),
		).toBe("env-key");
	});

	test("env absent, file present → trimmed file value", () => {
		lastRead.length = 0;
		expect(endpointKey(ep({ api_key_env: "LITELLM_KEY" }), {}, read)).toBe(
			"file-key",
		);
		expect(lastRead[0]?.endsWith("/litellm.key")).toBe(true);
	});

	test("env absent, file absent → undefined", () => {
		expect(
			endpointKey(ep({ api_key_env: "LITELLM_KEY" }), {}, () => undefined),
		).toBeUndefined();
	});

	test("env var with no mapped engine file stays env-only", () => {
		lastRead.length = 0;
		expect(
			endpointKey(ep({ api_key_env: "MYSTERY_KEY" }), {}, read),
		).toBeUndefined();
		expect(lastRead).toEqual([]);
	});

	test("no api_key and no api_key_env → undefined, no file read", () => {
		lastRead.length = 0;
		expect(endpointKey(ep(), {}, read)).toBeUndefined();
		expect(lastRead).toEqual([]);
	});
});
