import { mkdirSync, rmSync, symlinkSync } from "node:fs";
import { join, parse, relative } from "node:path";
import { expect, test } from "@playwright/test";
import { postureDocument, postureTree } from "./posture.fixtures.ts";
import { readPostureLayers } from "./posture.prefer.ts";
import { resolvePosture } from "./posture.resolve.ts";
import { PostureLayerSchema } from "./posture.zod.ts";

const fixtureTest = test.extend<{ tree: ReturnType<typeof postureTree> }>({
	// biome-ignore lint/correctness/noEmptyPattern: Playwright requires destructured fixture dependencies.
	tree: async ({}, use) => {
		const tree = postureTree();
		try {
			await use(tree);
		} finally {
			tree.cleanup();
		}
	},
});

fixtureTest(
	"parent references and nearer inline fields cross repo and worktree boundaries",
	{ tag: "@unit" },
	({ tree }) => {
		const parent = tree.write(
			tree.parent,
			JSON.stringify({ selection: { posture: "minimal" } }),
		);
		const near = tree.write(
			tree.worktree,
			JSON.stringify({
				hubs: {
					example: {
						profiles: { minimal: { models: { coder: { lanes: 0 } } } },
					},
				},
			}),
		);
		const layers = readPostureLayers(tree.worktree).filter((layer) =>
			layer.source.startsWith(tree.root),
		);
		expect(layers.map((layer) => layer.source)).toEqual([parent, near]);
		const resolved = resolvePosture(postureDocument(), layers);
		expect(resolved.selection.posture).toBe("minimal");
		expect(resolved.entries).toEqual([
			{ hub: "example", model: "coder", policy: "MUST", lanes: 0 },
		]);
		expect(resolved.sources["selection.posture"]).toBe(parent);
		expect(
			resolved.sources["hubs.example.profiles.minimal.models.coder.lanes"],
		).toBe(near);
		expect(readPostureLayers(relative(process.cwd(), tree.worktree))).toEqual(
			readPostureLayers(tree.worktree),
		);
	},
);

fixtureTest(
	"missing files and filesystem root terminate without creating layers",
	{ tag: "@unit" },
	({ tree }) => {
		expect(
			readPostureLayers(tree.worktree).filter((layer) =>
				layer.source.startsWith(tree.root),
			),
		).toEqual([]);
		expect(readPostureLayers(parse(tree.root).root).length).toBeLessThanOrEqual(
			1,
		);
	},
);

fixtureTest(
	"malformed JSON cannot restore defaults or discard a restrictive parent",
	{ tag: "@unit" },
	({ tree }) => {
		tree.write(tree.parent, '{"selection":{"posture":"minimal"}}');
		const source = tree.write(tree.worktree, ' \n {"version":1,\nmust=claude');
		expect(() => readPostureLayers(tree.worktree)).toThrow(
			`${source}: invalid JSON`,
		);
		tree.write(tree.worktree, '{"selection":{"developmentOverride":"yes"}}');
		expect(() => readPostureLayers(tree.worktree)).toThrow(
			`${source}:selection.developmentOverride`,
		);
	},
);

fixtureTest(
	"unreadable files are loud and symlink loops do not hang",
	{ tag: "@unit" },
	({ tree }) => {
		const source = join(tree.worktree, ".prefer");
		mkdirSync(source);
		expect(() => readPostureLayers(tree.worktree)).toThrow(
			`${source}: unreadable`,
		);
		rmSync(source, { recursive: true });
		symlinkSync(join(tree.root, "missing"), source);
		expect(() => readPostureLayers(tree.worktree)).toThrow(
			`${source}: unreadable`,
		);
		const loop = join(tree.repo, "loop");
		symlinkSync(loop, loop);
		expect(() => readPostureLayers(loop)).toThrow("unreadable");
	},
);

fixtureTest(
	"each JSON source is parsed exactly once",
	{ tag: "@unit" },
	({ tree }) => {
		const text = '{"version":1,"selection":{"posture":"minimal"}}';
		tree.write(tree.repo, text);
		const parseJson = JSON.parse;
		let count = 0;
		JSON.parse = (...args: Parameters<typeof JSON.parse>) => {
			if (args[0] === text) count++;
			return parseJson(...args);
		};
		try {
			readPostureLayers(tree.worktree);
			expect(count).toBe(1);
		} finally {
			JSON.parse = parseJson;
		}
	},
);

fixtureTest(
	"mixed formats preserve each legacy layer without inventing model rules",
	{ tag: "@unit" },
	({ tree }) => {
		const parent = tree.write(tree.parent, 'tag="outer"\nmust=opaque-parent');
		const repo = tree.write(tree.repo, '{"selection":{"posture":"minimal"}}');
		const near = tree.write(tree.worktree, 'color="#123456"\ncan=opaque-near');
		const layers = readPostureLayers(tree.worktree).filter((layer) =>
			layer.source.startsWith(tree.root),
		);
		expect(layers.map((layer) => layer.source)).toEqual([parent, repo, near]);
		expect(layers[0]?.legacy?.values).toEqual({ tag: "outer" });
		expect(layers[2]?.legacy?.values).toEqual({ color: "#123456" });
		expect(layers[1]?.legacy).toBeUndefined();
		expect(layers[0]?.overlay).toEqual({});
		expect(layers[2]?.overlay).toEqual({});
	},
);

fixtureTest(
	"bounded walks fail rather than silently omitting distant parents",
	{ tag: "@unit" },
	({ tree }) => {
		tree.write(tree.parent, '{"selection":{"posture":"minimal"}}');
		const deep = join(tree.worktree, ...Array.from({ length: 65 }, () => "d"));
		mkdirSync(deep, { recursive: true });
		expect(() => readPostureLayers(deep)).toThrow("walk exceeds 64");
	},
);

fixtureTest(
	"legacy planes retain exact tokens, line order, metadata and reserved must",
	{ tag: "@unit" },
	({ tree }) => {
		const source = tree.write(
			tree.repo,
			[
				'tag = "example"',
				'color = "#123aBC"',
				'prefer = "local llms"',
				'must = "cloud llms"',
				"must=claude,copilot",
				"prefer=opaque-token",
				"can=first",
				"can=last",
				"hub=example",
				"hub-url=https://one.invalid,https://two.invalid",
			].join("\n"),
		);
		const layer = readPostureLayers(tree.worktree).find(
			(value) => value.source === source,
		);
		expect(layer).toEqual({
			source,
			overlay: {},
			legacy: {
				values: {
					tag: "example",
					color: "#123aBC",
					prefer: "local llms",
					must: "cloud llms",
				},
				errors: [],
				executor: {
					directives: [
						{ value: "claude", kind: "must", line: 5 },
						{ value: "copilot", kind: "must", line: 5 },
						{ value: "opaque-token", kind: "prefer", line: 6 },
					],
					can: { value: "last", line: 8 },
					hub: "example",
					hubUrls: ["https://one.invalid", "https://two.invalid"],
				},
			},
		});
		expect(PostureLayerSchema.safeParse(layer).success).toBe(true);
	},
);

for (const [directive, value] of [
	["must", "opaque"],
	["prefer", "opaque"],
	["can", "opaque"],
	["hub", "example"],
	["hub-url", "https://example.invalid"],
] as const) {
	fixtureTest(
		`legacy ${directive} is independent of quoted routing`,
		{ tag: "@unit" },
		({ tree }) => {
			const source = tree.write(tree.repo, `${directive}=${value}`);
			const layer = readPostureLayers(tree.worktree).find(
				(entry) => entry.source === source,
			);
			expect(layer?.legacy?.values).toEqual({});
			expect(layer?.legacy?.errors).toEqual([]);
			expect(layer?.overlay).toEqual({});
		},
	);
}
