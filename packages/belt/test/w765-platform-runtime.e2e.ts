// w765-platform-runtime.test.ts — per-platform runtime attribute (W765):
// the platformDefinitions table, runtimeFor default/override, spawnArgs
// deriving llama.cpp argv from the attribute, and the registry runtime
// mirror on registryEntries().
import { expect, test } from "@playwright/test";
import {
	SPECIALISTS,
	platformDefinitions,
	registryEntries,
	runtimeFor,
	thisPlatform,
} from "../bin/registry.ts";
import { spawnArgs } from "../bin/spawner.ts";
import type { Specialist } from "../bin/registry.ts";

const spec = (over: Partial<Specialist> = {}): Specialist => ({
	port: 8902,
	model: "/models/qwen3-4b-q4_k_m.gguf",
	label: "extract",
	alias: "local-extract",
	role: "extract",
	ram_gb: 2.5,
	contextTokens: 262_144,
	tier: "resident",
	good_at: "x",
	...over,
});

test("platformDefinitions maps darwin=mlx/metal, win32=vulkan, linux=cpu @unit", () => {
	expect(platformDefinitions.darwin).toEqual({
		runtime: "mlx",
		accel: "metal",
	});
	expect(platformDefinitions.win32.runtime).toBe("llama.cpp");
	expect(platformDefinitions.win32.accel).toBe("vulkan");
	expect(platformDefinitions.linux.accel).toBe("cpu");
});

test("runtimeFor: platform default, row override wins @unit", () => {
	expect(runtimeFor(spec(), "win32")).toBe("llama.cpp");
	expect(runtimeFor(spec(), "darwin")).toBe("mlx");
	expect(runtimeFor(spec({ runtime: "mlx" }), "linux")).toBe("mlx");
});

test("spawnArgs: llama.cpp runtime derives llama-server argv per accel @unit", () => {
	const win = spawnArgs(spec(), "win32");
	expect(win[0]).toBe("llama-server");
	expect(win).toContain("--host");
	expect(win).toContain("127.0.0.1");
	expect(win).toContain("8902");
	expect(win).toContain("-ngl");
	expect(win).toContain("99");
	expect(win).toContain("--jinja");
	const lin = spawnArgs(spec(), "linux");
	expect(lin[0]).toBe("llama-server");
	expect(lin).not.toContain("-ngl");
});

test("spawnArgs: mlx rows on darwin keep today's argv (rapid for :8901) @unit", () => {
	const coder = SPECIALISTS.find((s) => s.port === 8901);
	if (!coder) throw new Error("registry lost :8901");
	if (thisPlatform() === "darwin") {
		expect(spawnArgs(coder)[0].endsWith("rapid-mlx")).toBe(true);
	}
	expect(runtimeFor(coder)).toBe(platformDefinitions[thisPlatform()].runtime);
});

test("embedding worker loads the embedding checkpoint on the advertised port @unit", () => {
	const embed = SPECIALISTS.find((s) => s.port === 8907);
	if (!embed) throw new Error("registry lost :8907");
	const args = spawnArgs(embed, "darwin");
	expect(args).toContain("8907");
	expect(args).toContain("--embedding-model");
	expect(args).toContain(embed.model);
	expect(args[2]).toBe(embed.serveModel);
});

test("registryEntries mirrors runtime on specialist rows @unit", () => {
	const entries = registryEntries();
	for (const e of entries) {
		if (e.external) continue;
		expect(e.runtime).toBe(platformDefinitions[thisPlatform()].runtime);
	}
});
