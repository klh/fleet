// tests/helpers/p1-findings.pin.ts — W1303.1.5: shrink-only pin of the P1
// guards' known findings (check-p1.ts --write-pin re-stamps it from the
// live run). A row excuses ONE finding shape on same check+pkg by prefix
// (startsWith). Remove a row when its finding is fixed upstream; a new
// finding fails the gate until it is either fixed or deliberately
// re-stamped in the landing that adds it.
export type P1Check = "versions" | "deps" | "pack";

export interface P1PinRow {
	check: P1Check;
	/** package the row is scoped to (dir name, no @klh/ prefix) */
	pkg: string;
	/** the excused finding's stable prefix (startsWith match) */
	prefix: string;
}

export const P1_PIN: readonly P1PinRow[] = [
	{
		check: "pack",
		pkg: "belt",
		prefix:
			'broken-import: node_modules/@klh/belt/bin/dashboard-observability.js: "./dashboard-state.js" resolves to nothing in the install',
	},
	{
		check: "pack",
		pkg: "belt",
		prefix:
			'broken-import: node_modules/@klh/belt/bin/dashboard-observability.js: "./observation.js" resolves to nothing in the install',
	},
	{
		check: "pack",
		pkg: "speedy",
		prefix:
			'broken-import: node_modules/@klh/speedy/skills/klh-lit-dev/template.ts: "./component-name.zod.js" resolves to nothing in the install',
	},
	{
		check: "pack",
		pkg: "speedy",
		prefix:
			'unresolved-dep: node_modules/@klh/speedy/skills/klh-lit-dev/template.ts: "lit" does not resolve from the install',
	},
	{
		check: "pack",
		pkg: "speedy",
		prefix:
			'unresolved-dep: node_modules/@klh/speedy/skills/klh-lit-dev/template.ts: "lit/decorators.js" does not resolve from the install',
	},
	{
		check: "pack",
		pkg: "speedy",
		prefix:
			'unresolved-dep: node_modules/@klh/speedy/skills/klh-lit-dev/template.ts: "lit/directives/class-map.js" does not resolve from the install',
	},
	{
		check: "pack",
		pkg: "speedy",
		prefix:
			'unresolved-dep: node_modules/@klh/speedy/skills/klh-lit-dev/template.ts: "lit/directives/when.js" does not resolve from the install',
	},
	{
		check: "pack",
		pkg: "suspenders",
		prefix:
			'parent-path-escape: node_modules/@klh/suspenders/deploy/hub-metrics.ts: "../../buckle/src/metrics-connector.ts" escapes the package root — a hidden parent-path dep that works only inside the monorepo checkout',
	},
	{
		check: "pack",
		pkg: "suspenders",
		prefix:
			'parent-path-escape: node_modules/@klh/suspenders/deploy/hub-policy.ts: "../../buckle/src/policy.ts" escapes the package root — a hidden parent-path dep that works only inside the monorepo checkout',
	},
	{
		check: "pack",
		pkg: "suspenders",
		prefix:
			'parent-path-escape: node_modules/@klh/suspenders/hooks/bin/fallback-drill.ts: "../../../buckle/src/usage.ts" escapes the package root — a hidden parent-path dep that works only inside the monorepo checkout',
	},
	{
		check: "pack",
		pkg: "suspenders",
		prefix:
			'parent-path-escape: node_modules/@klh/suspenders/hooks/bin/prefix-keepwarm.ts: "../../../buckle/src/usage.ts" escapes the package root — a hidden parent-path dep that works only inside the monorepo checkout',
	},
	{
		check: "pack",
		pkg: "suspenders",
		prefix:
			'parent-path-escape: node_modules/@klh/suspenders/hooks/board/buckle-observation-relay.ts: "../../../buckle/src/network-read-model.ts" escapes the package root — a hidden parent-path dep that works only inside the monorepo checkout',
	},
	{
		check: "pack",
		pkg: "suspenders",
		prefix:
			'parent-path-escape: node_modules/@klh/suspenders/hooks/board/buckle-observation-relay.ts: "../../../buckle/src/projection.ts" escapes the package root — a hidden parent-path dep that works only inside the monorepo checkout',
	},
	{
		check: "pack",
		pkg: "suspenders",
		prefix:
			'parent-path-escape: node_modules/@klh/suspenders/hooks/board/network-overview.ts: "../../../buckle/src/network-read-model.ts" escapes the package root — a hidden parent-path dep that works only inside the monorepo checkout',
	},
	{
		check: "pack",
		pkg: "suspenders",
		prefix:
			'parent-path-escape: node_modules/@klh/suspenders/hooks/board/network-overview.ts: "../../../buckle/src/topology-read-model.ts" escapes the package root — a hidden parent-path dep that works only inside the monorepo checkout',
	},
	{
		check: "pack",
		pkg: "suspenders",
		prefix:
			'parent-path-escape: node_modules/@klh/suspenders/hooks/board/routes-observations.ts: "../../../buckle/src/network-read-model.ts" escapes the package root — a hidden parent-path dep that works only inside the monorepo checkout',
	},
	{
		check: "pack",
		pkg: "suspenders",
		prefix:
			'parent-path-escape: node_modules/@klh/suspenders/hooks/board/routes-observations.ts: "../../../buckle/src/projection.ts" escapes the package root — a hidden parent-path dep that works only inside the monorepo checkout',
	},
	{
		check: "pack",
		pkg: "suspenders",
		prefix:
			'unresolved-dep: node_modules/@klh/suspenders/scripts/build-vendor.ts: "acorn" does not resolve from the install',
	},
];
