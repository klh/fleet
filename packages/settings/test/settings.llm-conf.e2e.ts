// settings.llm-conf.e2e.ts — W2760: the LLM-plane doc resolver order.
// Pins: explicit path > env pin > settings.json law home > legacy local-llm
// side files (.json law name first, legacy .yaml name only while its content
// is JSON) > none. A configured-but-missing pin walks on for diagnosis
// parity (callers own the fatal).

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import {
	jsonSiblingOf,
	resolvePolicyDoc,
	resolveUpstreamsDoc,
} from "../src/settings.llm-conf.ts";

const world = (): { home: string; env: Record<string, string | undefined> } => {
	const home = mkdtempSync(join(tmpdir(), "w2760-llm-conf-"));
	mkdirSync(join(home, ".config", "klh"), { recursive: true });
	mkdirSync(join(home, ".claude", "local-llm"), { recursive: true });
	return { home, env: { HOME: home } };
};
const clean = (home: string): void =>
	rmSync(home, { recursive: true, force: true });

test("resolves nothing from an empty world", () => {
	const w = world();
	expect(resolveUpstreamsDoc(undefined, w.env)).toEqual({
		source: "none",
		text: null,
		path: null,
	});
	clean(w.home);
});

test("settings.json law home beats the legacy side files", () => {
	const w = world();
	writeFileSync(
		join(w.home, ".config", "klh", "settings.json"),
		JSON.stringify({ upstreams: { groups: { belt: [] } } }),
	);
	writeFileSync(
		join(w.home, ".claude", "local-llm", "upstreams.json"),
		JSON.stringify({ groups: { legacy: [] } }),
	);
	const r = resolveUpstreamsDoc(undefined, w.env);
	expect(r.source).toBe("settings");
	expect(JSON.parse(r.text ?? "{}")).toEqual({ groups: { belt: [] } });
	expect(r.path).toBeNull();
	clean(w.home);
});

test("env pin beats settings; explicit beats the pin", () => {
	const w = world();
	const pin = join(w.home, "pinned.json");
	writeFileSync(pin, JSON.stringify({ groups: { pin: [] } }));
	writeFileSync(
		join(w.home, ".config", "klh", "settings.json"),
		JSON.stringify({ upstreams: { groups: { settings: [] } } }),
	);
	const r1 = resolveUpstreamsDoc(undefined, {
		...w.env,
		BUCKLE_UPSTREAMS: pin,
	});
	expect(r1.source).toBe("explicit");
	expect(r1.text).toContain("pin");
	const explicit = join(w.home, "explicit.json");
	writeFileSync(explicit, JSON.stringify({ groups: { top: [] } }));
	const r2 = resolveUpstreamsDoc(explicit, { ...w.env, BUCKLE_UPSTREAMS: pin });
	expect(r2.text).toContain("top");
	clean(w.home);
});

test("yaml-name side file is honored only while its content is JSON", () => {
	const w = world();
	writeFileSync(
		join(w.home, ".claude", "local-llm", "upstreams.yaml"),
		JSON.stringify({ groups: { yamlNameJsonBody: [] } }),
	);
	const ok = resolveUpstreamsDoc(undefined, w.env);
	expect(ok.source).toBe("legacy-yaml-json");
	writeFileSync(
		join(w.home, ".claude", "local-llm", "upstreams.yaml"),
		"groups: {still: yaml}",
	);
	expect(resolveUpstreamsDoc(undefined, w.env).source).toBe("none");
	clean(w.home);
});

test("jsonSiblingOf rewrites yaml names only", () => {
	expect(jsonSiblingOf("/a/b/upstreams.yaml")).toBe("/a/b/upstreams.json");
	expect(jsonSiblingOf("/a/b/upstreams.YML")).toBe("/a/b/upstreams.json");
	expect(jsonSiblingOf("/a/b/upstreams.json")).toBe("/a/b/upstreams.json");
});

test("policy chain: env pins in order, then settings, then side files", () => {
	const w = world();
	const beltPin = join(w.home, "belt.json");
	writeFileSync(beltPin, JSON.stringify({ gateway: { num_retries: 1 } }));
	writeFileSync(
		join(w.home, ".config", "klh", "settings.json"),
		JSON.stringify({ routing_policy: { gateway: { num_retries: 2 } } }),
	);
	const r1 = resolvePolicyDoc(undefined, { ...w.env, BELT_POLICY: beltPin });
	expect(r1.source).toBe("explicit");
	expect(r1.text).toContain('num_retries":1');
	const bucklePin = join(w.home, "buckle.json");
	writeFileSync(bucklePin, JSON.stringify({ gateway: { num_retries: 3 } }));
	const r2 = resolvePolicyDoc(undefined, {
		...w.env,
		BUCKLE_POLICY: bucklePin,
	});
	expect(r2.text).toContain('num_retries":3');
	writeFileSync(
		join(w.home, ".claude", "local-llm", "routing-policy.json"),
		JSON.stringify({ gateway: { num_retries: 4 } }),
	);
	const r3 = resolvePolicyDoc(undefined, w.env);
	expect(r3.source).toBe("settings");
	const noSettings = { ...w.env, HOME: w.home };
	rmSync(join(w.home, ".config", "klh", "settings.json"));
	const r4 = resolvePolicyDoc(undefined, noSettings);
	expect(r4.source).toBe("legacy-json");
	clean(w.home);
});
