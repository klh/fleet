// Rebuild the offline runtime from Fleet's pinned suspenders Lit dependency.
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

process.env.NODE_ENV = "production";

const require = createRequire(
	new URL("../../suspenders/package.json", import.meta.url),
);
const result = await Bun.build({
	entrypoints: [fileURLToPath(new URL("./lit-entry.js", import.meta.url))],
	target: "browser",
	conditions: ["browser", "production"],
	define: { "process.env.NODE_ENV": '"production"' },
	minify: true,
	plugins: [
		{
			name: "fleet-lit",
			setup(builder) {
				builder.onResolve({ filter: /^lit$/ }, () => ({
					path: require.resolve("lit"),
				}));
			},
		},
	],
});
if (!result.success) throw new Error(result.logs.map(String).join("\n"));
await Bun.write(
	new URL("../bin/vendor/lit-shared.js", import.meta.url),
	result.outputs[0],
);
