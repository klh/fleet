// test/bash-hardening.test.ts — the W513 bash-hardening lift: pure primitive
// tests (nesting, wrapper swallowing, deny-reason classification).
import {
	backticksToSubshells,
	commandStart,
	destructiveGitLabel,
	gateSegments,
	deviceDenyReason,
	sensitiveDenyReason,
	containmentDenyReason,
} from "../hooks/gates/bash-hardening.ts";

describe("gateSegments (quote-aware + nested)", () => {
	test("$(...) inner commands arrive as segments", () => {
		expect(gateSegments("echo $(git push origin main)")).toContainEqual([
			"git",
			"push",
			"origin",
			"main",
		]);
	});
	test("backticks rewrite to $(...) and segment", () => {
		expect(gateSegments("echo hi; `git push`")).toContainEqual(["git", "push"]);
	});
	test("backticks inside single quotes stay literal", () => {
		expect(gateSegments("echo '`git push`'")).not.toContainEqual([
			"git",
			"push",
		]);
	});
	test("sh -c payload unwraps into segments", () => {
		expect(gateSegments("sh -c 'git reset --hard'")).toContainEqual([
			"git",
			"reset",
			"--hard",
		]);
	});
	test("quoted 'git push' stays one word — no false segment", () => {
		expect(gateSegments('echo "git push"')).toEqual([["echo", "git push"]]);
	});
});

describe("commandStart (wrapper value-swallowing)", () => {
	test("sudo -u root git → git", () =>
		expect(commandStart(["sudo", "-u", "root", "git", "push"])).toBe(3));
	test("env -u FOO git → git", () =>
		expect(commandStart(["env", "-u", "FOO", "git"])).toBe(3));
	test("exec -a name git → git", () =>
		expect(commandStart(["exec", "-a", "name", "git"])).toBe(3));
	test("time -f fmt git → git", () =>
		expect(commandStart(["time", "-f", "%e", "git"])).toBe(3));
	test("nice -n 5 git → git", () =>
		expect(commandStart(["nice", "-n", "5", "git"])).toBe(3));
	test("VAR=1 git → git", () => expect(commandStart(["VAR=1", "git"])).toBe(1));
	test("env FOO=1 git → git", () =>
		expect(commandStart(["env", "FOO=1", "git"])).toBe(2));
	test("sudo -- git → git", () =>
		expect(commandStart(["sudo", "--", "git"])).toBe(2));
	test("plain cmd → 0", () => expect(commandStart(["ls", "-la"])).toBe(0));
});

describe("backticksToSubshells", () => {
	test("simple rewrite", () =>
		expect(backticksToSubshells("a `b c` d")).toBe("a $(b c) d"));
	test("single-quoted backtick untouched", () =>
		expect(backticksToSubshells("a '`b`'")).toBe("a '`b`'"));
	test("escaped backtick does not open", () =>
		expect(backticksToSubshells("a \\`b")).toBe("a \\`b"));
});

describe("deny reasons (device / sensitive / containment)", () => {
	test("/dev/sda denied", () =>
		expect(deviceDenyReason("/dev/sda")).toContain("device redirect"));
	test("/dev/disk0 denied", () =>
		expect(deviceDenyReason("/dev/disk0")).toContain("device redirect"));
	test("/dev/null fine", () => expect(deviceDenyReason("/dev/null")).toBe(""));
	test("/dev/stderr fine", () =>
		expect(deviceDenyReason("/dev/stderr")).toBe(""));
	test("/dev/fd/3 fine", () => expect(deviceDenyReason("/dev/fd/3")).toBe(""));
	test(".git path denied", () =>
		expect(sensitiveDenyReason("/r/.git/hooks/pre-commit")).toContain(
			"governed Edit/Write",
		));
	test(".env exact denied", () =>
		expect(sensitiveDenyReason("/r/pkg/.env")).toContain(
			"governed Edit/Write",
		));
	test(".env.example writable", () =>
		expect(sensitiveDenyReason("/r/pkg/.env.example")).toBe(""));
	test("containment: inside worktree fine", () =>
		expect(containmentDenyReason("/wt/sub/x", "/wt")).toBe(""));
	test("containment: outside denied", () =>
		expect(containmentDenyReason("/etc/hosts", "/wt")).toContain(
			"outside this lane's worktree",
		));
	test("containment: /tmp carve-out", () =>
		expect(containmentDenyReason("/tmp/x", "/wt")).toBe(""));
});

describe("destructiveGitLabel", () => {
	const label = (...w: string[]) => destructiveGitLabel(w);
	test("reset --hard hits", () =>
		expect(label("git", "reset", "--hard")).toBe("git reset --hard"));
	test("reset soft misses", () =>
		expect(label("git", "reset", "HEAD~1")).toBe(""));
	test("clean -fd hits", () =>
		expect(label("git", "clean", "-fd")).toBe("git clean -f"));
	test("clean -nd (dry-run) misses", () =>
		expect(label("git", "clean", "-nd")).toBe(""));
	test("clean -e pat -f hits", () =>
		expect(label("git", "clean", "-e", "pat", "-f")).toBe("git clean -f"));
	test("branch -D hits", () =>
		expect(label("git", "branch", "-D", "x")).toBe("git branch -D"));
	test("branch -d misses", () =>
		expect(label("git", "branch", "-d", "x")).toBe(""));
	test("branch --delete --force hits", () =>
		expect(label("git", "branch", "--delete", "--force", "x")).toBe(
			"git branch -D",
		));
	test("checkout . hits", () =>
		expect(label("git", "checkout", ".")).toContain("working-tree discard"));
	test("checkout main misses", () =>
		expect(label("git", "checkout", "main")).toBe(""));
	test("checkout -b new misses", () =>
		expect(label("git", "checkout", "-b", "new")).toBe(""));
	test("restore -- . hits", () =>
		expect(label("git", "restore", "--", ".")).toContain(
			"working-tree discard",
		));
	test("restore src misses", () =>
		expect(label("git", "restore", "src")).toBe(""));
	test("non-git misses", () => expect(label("ls", "reset", "--hard")).toBe(""));
});
