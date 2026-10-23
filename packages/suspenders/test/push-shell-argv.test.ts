import { expect, test } from "bun:test";
import { gateSegments } from "../hooks/gates/bash-hardening.ts";
import { withoutPushRedirections } from "../hooks/lib/push-shell-argv.ts";

const argv = (source: string) => gateSegments(source, withoutPushRedirections);

test("redirection spans preserve actual numeric and quoted words", () => {
	expect(argv("git push origin 2 >out")).toEqual([
		["git", "push", "origin", "2"],
	]);
	expect(argv("git push origin '2'>out")).toEqual([
		["git", "push", "origin", "2"],
	]);
	expect(argv("git push origin main 2>out")).toEqual([
		["git", "push", "origin", "main"],
	]);
	expect(argv('git push origin "safe>ref" 12>>"output > name"')).toEqual([
		["git", "push", "origin", "safe>ref"],
	]);
	expect(argv("git push origin safe\\>ref 2>&1")).toEqual([
		["git", "push", "origin", "safe>ref"],
	]);
	expect(argv("git push origin main '2>&1'")).toEqual([
		["git", "push", "origin", "main", "2>&1"],
	]);
});

test("wrapped commands use the same recursive argv projection", () => {
	const segments = argv("sh -c 'git push origin main 2>&1 | tail -5'");
	expect(segments).toContainEqual(["git", "push", "origin", "main"]);
	expect(segments).toContainEqual(["tail", "-5"]);
});

test("unknown dynamic or incomplete redirections fail closed", () => {
	for (const source of [
		"git push origin main >",
		"git push origin main >\nnext",
		"git push origin main <<EOF",
		"git push origin main >$(echo out)",
		"git push origin $BRANCH >out",
		// biome-ignore lint/suspicious/noTemplateCurlyInString: shell expansion must fail closed
		'git push origin "${BRANCH}" >out',
		"git push origin `echo main`",
		"git push origin main >'unfinished",
		"git push origin main >out\\",
	])
		expect(() => argv(source), source).toThrow();
});
