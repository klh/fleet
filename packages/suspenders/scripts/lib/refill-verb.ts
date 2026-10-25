// refill-verb.ts — the dispatch CLI's refill verb declaration (W1255.6
// verb-kit finish): one spec owns the flag vocabulary; parseVerb owns the
// argv dissection (dispatch-next.ts retires its hand-rolled indexOf shim).
// lax keeps dispatch's legacy tolerance of unknown flags; `--flag=value`
// now parses where indexOf couldn't. Own module so tests can import the
// spec without importing the whole dispatch machine.
import { defineVerb } from "../../hooks/lib/verb-kit.ts";

export const refillVerb = defineVerb({
	name: "refill",
	usage: "Usage: dispatch [options]",
	flags: [
		"--repo",
		"--target",
		"--item",
		"--route",
		"--show-capsule",
		"--resume-from",
		"--role",
	],
	switches: ["--dry-run", "--no-belt", "--allow-ungoverned"],
	lax: true,
});
