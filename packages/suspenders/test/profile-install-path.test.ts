// test/profile-install-path.test.ts — W736: the DEFAULT resolution path (no
// KLH_CAPABILITIES_FILE override). sync-harness.ts writes capabilities.json
// at the installed prefix root while profile.ts rides a lib/ symlink into
// .harness and Bun realpaths import.meta.path — pre-fix, the resolver looked
// inside the payload and every default-path install silently read hub
// posture (a spoke's hub-only flags silently ON). Replicates the install
// layout: payload hooks under <prefix>/.harness, lib/ linked at the root.
// The payload profile.ts is a REAL file (git-archive extraction semantics) —
// a symlink would let Bun realpath past the payload to the repo copy.
import { describe, expect, setDefaultTimeout, test } from "bun:test";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import {
	CAP_AUTH_ISSUANCE,
	hasCapability,
	spokeCapabilities,
} from "../hooks/lib/profile.ts";

setDefaultTimeout(20_000);

const PROFILE = join(import.meta.dir, "..", "hooks", "lib", "profile.ts");

const PROBE = `
const m = await import(process.env.W736_ENTRY);
const fs = await import("node:fs");
const f = m.capabilitiesFile();
console.log(JSON.stringify({
	resolved: f,
	exists: fs.existsSync(f),
	flags: m.readCapabilities(),
}));
`;

/** Probe the resolver from a child bun process with the default path:
 *  fresh module cache + fresh mtime cache, no KLH_CAPABILITIES_FILE. */
const probe = (prefix: string) => {
	const child = Bun.spawnSync(["bun", "-e", PROBE], {
		env: {
			...process.env,
			KLH_CAPABILITIES_FILE: "",
			W736_ENTRY: join(prefix, "lib", "profile.ts"),
		},
		stdout: "pipe",
		stderr: "pipe",
	});
	if (child.exitCode !== 0)
		throw new Error(`probe failed: ${child.stderr.toString().slice(-1500)}`);
	return JSON.parse(child.stdout.toString()) as {
		resolved: string;
		exists: boolean;
		flags: Record<string, boolean>;
	};
};

const buildPrefix = (): string => {
	const prefix = mkdtempSync(join(process.cwd(), ".w736-prefix-"));
	const payloadLib = join(prefix, ".harness/packages/suspenders/hooks/lib");
	mkdirSync(payloadLib, { recursive: true });
	// the payload copy is a real file: the install layout's git-archive
	// extraction produces real files, and a symlink would let Bun's realpath
	// walk past the payload to the repo original
	writeFileSync(join(payloadLib, "profile.ts"), readFileSync(PROFILE));
	symlinkSync(payloadLib, join(prefix, "lib"));
	return prefix;
};

describe("W736: default-path capabilities resolution (installed prefix)", () => {
	test("resolver finds the prefix-root file through the .harness layout", () => {
		const prefix = buildPrefix();
		const out = probe(prefix);
		// sync-harness.ts writes at the stage/prefix root — the resolver must
		// land there, not inside the payload
		expect(out.resolved).toBe(join(prefix, "capabilities.json"));
		// absent file on a fresh prefix = hub (dev exemption intact)
		expect(out.exists).toBe(false);
		expect(hasCapability(out.flags, CAP_AUTH_ISSUANCE)).toBe(true);
		rmSync(prefix, { recursive: true, force: true });
	});

	test("a prefix-root capabilities.json governs the default path (spoke fail-safe)", () => {
		const prefix = buildPrefix();
		// mimic the sync-harness stage-root write, then re-probe: the spoke
		// preset must reach the resolver with no override set
		writeFileSync(
			join(prefix, "capabilities.json"),
			JSON.stringify(spokeCapabilities()),
		);
		const out = probe(prefix);
		expect(out.exists).toBe(true);
		const spoke = spokeCapabilities();
		for (const [name, on] of Object.entries(spoke)) {
			expect(out.flags[name]).toBe(on);
		}
		expect(hasCapability(out.flags, CAP_AUTH_ISSUANCE)).toBe(false);
		rmSync(prefix, { recursive: true, force: true });
	});

	test("repo-checkout fallback: no .harness ancestor reads beside lib/", () => {
		// the walk must not mis-fire where no .harness owns the tree — the
		// fallback stays hooks-beside-lib (dev exemption keeps this absent)
		expect(
			existsSync(join(import.meta.dir, "../hooks/capabilities.json")),
		).toBe(false);
	});
});
