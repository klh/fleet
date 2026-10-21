// W1104.1 review #55056: the standalone Belt installer must hold
// .belt-overlay.lock only across copy + runtime-heal/closure verification —
// released before the tier manifest, model setup and launchd activation, so
// a supervised router never sees a locked runtime outside the copy window.
// The lane fence denies executing the installer (it contains launchctl), so
// this asserts the script's content ordering instead.
import { expect, test } from "bun:test";
import { dirname, join } from "node:path";

const INSTALL = join(dirname(import.meta.path), "..", "install.sh");

const script = await Bun.file(INSTALL).text();

// Operative lines only — comments may mention the same words earlier.
const idx = (needle: string): number => script.indexOf(needle);

test("installer acquires the lock before the first copy and the heal", () => {
	const acquire = idx('LOCK="$PREFIX/.belt-overlay.lock"');
	const trap = idx("trap 'rm -rf \"$LOCK\"' EXIT");
	const copy = idx('for item in "$REPO_DIR"/bin/*');
	const heal = idx('bun "$REPO_DIR/bin/runtime-heal.ts"');
	expect(acquire).toBeGreaterThanOrEqual(0);
	expect(trap).toBeGreaterThan(acquire);
	expect(copy).toBeGreaterThan(trap);
	expect(heal).toBeGreaterThan(copy);
});

test("installer releases the lock after the heal, before activation", () => {
	const heal = idx('bun "$REPO_DIR/bin/runtime-heal.ts"');
	const release = idx('rm -rf "$LOCK"\ntrap - EXIT');
	const tier = idx('bun "$REPO_DIR/bin/registry-emit.ts"');
	const models = idx('bun "$REPO_DIR/setup/llm-stack.ts"');
	const launchd = idx("launchctl bootout");
	expect(release).toBeGreaterThan(heal);
	expect(tier).toBeGreaterThan(release);
	expect(models).toBeGreaterThan(release);
	expect(launchd).toBeGreaterThan(release);
});

test("installer refuses a concurrent lock owner", () => {
	expect(script).toContain('if ! mkdir "$LOCK"');
	expect(script).toContain("another belt install/refresh owns the runtime");
});

test("installer releases the lock on the runtime-heal failure path", () => {
	// the EXIT trap is installed with the lock and only disarmed by the
	// success-path release above
	expect(script).toContain("trap 'rm -rf \"$LOCK\"' EXIT");
	expect(script).toContain("trap - EXIT");
});
