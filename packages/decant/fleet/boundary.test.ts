// fleet/boundary.test.ts — W1303.1.10: the vendored-byte boundary. decant
// carries a fleet-owned adapter layer (fleet/) that upstream src/ reaches into
// through exactly three sanctioned seams; everything else flows one way —
// adapters may read upstream, upstream must never grow new dependencies on the
// fleet layer. Locks the seam count so vendor upgrades cannot silently widen
// the reverse edge (W950 vendoring law: upstream bytes stay pristine).

import { expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const PKG_DIR = join(import.meta.dir, "..");
// the vendored snapshot ships two TS layers: upstream src/ and the fleet-owned
// fleet/ adapter layer (upstream tests were dropped with their surfaces).
const FLEET_LAYERS = new Set(["fleet", "src"]);

/** `from "<...>/fleet/<name>.ts"` — an upstream import of the adapter layer. */
const FLEET_IMPORT = /from\s+"[^"]*\/fleet\/([a-z-]+)\.ts"/g;
function layers(): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const layer of FLEET_LAYERS) {
    const dir = join(PKG_DIR, layer);
    const files: string[] = [];
    const walk = (d: string): void => {
      for (const entry of readdirSync(d)) {
        const path = join(d, entry);
        if (statSync(path).isDirectory()) walk(path);
        else if (entry.endsWith(".ts")) files.push(path);
      }
    };
    walk(dir);
    out.set(layer, files);
  }
  return out;
}

test("upstream imports of the fleet layer hit only the sanctioned seams", () => {
  const seams = new Map<string, number>([
    ["src/cli/commands/sync", 2], // afterSync + sessionSourcePaths
    ["src/watch", 2], // sessionSourcePaths + ensureConfidenceTable
    ["src/cli/context", 2], // sessionSourcePaths + ensureConfidenceTable
  ]);
  let total = 0;
  for (const [layer, files] of layers()) {
    if (layer === "fleet") continue;
    for (const file of files) {
      const rel = file.slice(PKG_DIR.length + 1).replace(/\.ts$/, "");
      for (const match of readFileSync(file, "utf8").matchAll(FLEET_IMPORT)) {
        total += 1;
        const n = seams.get(rel) ?? 0;
        expect(
          n,
          `${rel} imports fleet/${match[1]}.ts outside a sanctioned seam`,
        ).toBeGreaterThan(0);
        seams.set(rel, n - 1);
      }
    }
  }
  // every sanctioned seam is live AND no extra ones exist
  expect(
    total,
    "upstream->fleet seam count drifted (vendor upgrade widened it?)",
  ).toBe(6);
  for (const [rel, remaining] of seams) {
    expect(remaining, `sanctioned seam ${rel} went dark`).toBe(0);
  }
});

test("fleet adapters keep only the skills-catalog vendor edges", () => {
  // fleet->upstream reads are the adapter direction (allowed). The layer
  // holds exactly TWO cross-package edges, both the W918 skills-catalog
  // vendor module (registry.ts type-only + after-sync.ts value import),
  // ratcheted by tests/fleet.import-law.guard.
  const VENDOR_IMPORT = /from\s+"([^"]*suspenders\/[^"]*)"/g;
  for (const file of layers().get("fleet")!) {
    for (const match of readFileSync(file, "utf8").matchAll(VENDOR_IMPORT)) {
      expect(
        match[1]?.endsWith("skills-agents.ts"),
        `${file} -> ${match[1]}: only skills-agents may cross`,
      ).toBe(true);
    }
  }
});
