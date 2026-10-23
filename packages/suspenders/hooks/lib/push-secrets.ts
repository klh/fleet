// PreToolUse push secrets scan: immutable outgoing commits, not every local ref.
import { spawnSync } from "node:child_process";

const OID = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
const FLAGS = new Set([
	"-f",
	"--force",
	"--force-if-includes",
	"--atomic",
	"-q",
	"--quiet",
	"-v",
	"--verbose",
	"-u",
	"--set-upstream",
	"--porcelain",
	"-n",
	"--dry-run",
	"--progress",
	"--no-progress",
	"--thin",
	"--no-thin",
	"--signed",
	"--no-signed",
	"--prune",
]);
function git(repo: string, args: string[], input?: string): string {
	const result = spawnSync("git", args, {
		cwd: repo,
		encoding: "utf8",
		input,
		timeout: 30_000,
		maxBuffer: 4 * 1024 * 1024,
		env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
	});
	if (result.status !== 0)
		throw Error("push Git objects or remote could not be resolved");
	return result.stdout.trim();
}
function config(repo: string, name: string): string {
	const result = spawnSync("git", ["config", "--get-all", name], {
		cwd: repo,
		encoding: "utf8",
		timeout: 5000,
	});
	if (result.status === 1) return "";
	if (result.status !== 0) throw Error("push configuration unavailable");
	return result.stdout.trim();
}
const resolveObject = (repo: string, ref: string): string => {
	const oid = git(repo, ["rev-parse", "--verify", "--end-of-options", ref]);
	if (!OID.test(oid)) throw Error("push source is not one resolved Git object");
	return oid;
};
function commitOf(repo: string, ref: string): string | null {
	try {
		return resolveObject(repo, `${ref}^{commit}`);
	} catch {
		return null;
	}
}
function refs(repo: string, prefix: string): string[] {
	return git(repo, ["for-each-ref", "--format=%(refname)", prefix])
		.split("\n")
		.filter(Boolean);
}

export function outgoingPushObjects(
	repo: string,
	args: string[],
): { logOptions: string | null; tagObjects: string[] } {
	if (git(repo, ["rev-parse", "--is-shallow-repository"]) !== "false")
		throw Error("push secrets scan requires complete local history");
	let remote = "",
		all = false,
		tags = false,
		mirror = false,
		deleting = false,
		followTags = false;
	const specs: string[] = [];
	let options = true;
	for (let i = 0; i < args.length; i++) {
		const word = args[i];
		if (options && word === "--") {
			options = false;
			continue;
		}
		if (options && word.startsWith("-")) {
			if (word === "--all") all = true;
			else if (word === "--tags") tags = true;
			else if (word === "--mirror") mirror = true;
			else if (word === "--delete" || word === "-d") deleting = true;
			else if (word === "--follow-tags") followTags = true;
			else if (word === "--repo") {
				remote = args[++i] ?? "";
				if (!remote) throw Error("missing push remote");
			} else if (word.startsWith("--repo=")) remote = word.slice(7);
			else if (word === "-o" || word === "--push-option") {
				if (!args[++i]) throw Error("missing push option");
			} else if (
				word.startsWith("--push-option=") ||
				word.startsWith("--force-with-lease=") ||
				word === "--force-with-lease" ||
				word.startsWith("--signed=")
			) {
				/* no object selection change */
			} else if (!FLAGS.has(word))
				throw Error("unsupported push option; outgoing scan refused");
			continue;
		}
		if (!remote) remote = word;
		else specs.push(word);
	}
	const branch = git(repo, ["branch", "--show-current"]);
	if (!remote)
		remote =
			(branch && config(repo, `branch.${branch}.pushRemote`)) ||
			config(repo, "remote.pushDefault") ||
			(branch && config(repo, `branch.${branch}.remote`)) ||
			"origin";
	if (!remote || remote.includes("\n")) throw Error("ambiguous push remote");
	mirror ||= config(repo, `remote.${remote}.mirror`) === "true";
	const namedRemote = git(repo, ["remote"]).split("\n").includes(remote);
	const urls = namedRemote
		? git(repo, ["remote", "get-url", "--push", "--all", remote])
		: "";
	if (!namedRemote) {
		const rewrite = spawnSync(
			"git",
			["config", "--get-regexp", "^url\\..*\\.pushInsteadOf$"],
			{ cwd: repo, encoding: "utf8" },
		);
		if (rewrite.status !== 1)
			throw Error("raw push endpoint with rewrite rules cannot be proven");
	}
	if (urls.includes("\n"))
		throw Error("multiple push URLs require separate verified pushes");
	const endpoint = urls || remote;
	const advertised = git(repo, ["ls-remote", "--refs", "--", endpoint]);
	const remoteRefs = new Map<string, string>();
	for (const line of advertised.split("\n").filter(Boolean)) {
		const [oid, name] = line.split("\t");
		if (!OID.test(oid) || !name?.startsWith("refs/"))
			throw Error("invalid remote reference advertisement");
		remoteRefs.set(name, oid);
	}
	if (!specs.length && !all && !tags && !mirror) {
		const configured = config(repo, `remote.${remote}.push`);
		if (configured) specs.push(...configured.split("\n"));
		else {
			const mode = config(repo, "push.default") || "simple";
			if (mode === "matching") specs.push(":");
			else if (mode === "current" && branch) specs.push(branch);
			else if ((mode === "simple" || mode === "upstream") && branch) {
				const upstream = config(repo, `branch.${branch}.merge`);
				if (
					!upstream ||
					(mode === "simple" && upstream !== `refs/heads/${branch}`)
				)
					throw Error("default push target is unresolved");
				specs.push(`${branch}:${upstream}`);
			} else throw Error("default push selection is unsupported or detached");
		}
	}
	if (all || mirror)
		specs.push(...refs(repo, mirror ? "refs/" : "refs/heads/"));
	if (tags) specs.push(...refs(repo, "refs/tags/"));
	const sources = new Set<string>();
	for (let index = 0; index < specs.length; index++) {
		let spec = specs[index];
		if (spec.startsWith("+")) spec = spec.slice(1);
		if (deleting || (spec.startsWith(":") && spec !== ":")) continue;
		if (spec === ":") {
			for (const ref of refs(repo, "refs/heads/"))
				if (remoteRefs.has(ref)) sources.add(ref);
			continue;
		}
		if (spec === "tag") {
			const tag = specs[++index];
			if (!tag || tag.startsWith("-")) throw Error("missing push tag name");
			sources.add(`refs/tags/${tag}`);
			continue;
		}
		const source = spec.split(":")[0];
		if (!source || source.startsWith("-")) throw Error("invalid push source");
		if (source.includes("*")) {
			const pair = spec.split(":");
			if (
				pair.length !== 2 ||
				source.split("*").length !== 2 ||
				pair[1].split("*").length !== 2
			)
				throw Error("invalid wildcard push refspec");
			const [start, end] = source.split("*");
			for (const ref of refs(repo, start))
				if (ref.startsWith(start) && ref.endsWith(end)) sources.add(ref);
		} else sources.add(source);
	}
	const remoteObjects = new Set(remoteRefs.values());
	const tips = new Set<string>(),
		tagObjects = new Set<string>();
	const add = (source: string) => {
		const object = resolveObject(repo, source),
			commit = commitOf(repo, object);
		if (!commit) throw Error("push source is not a commit or commit tag");
		tips.add(commit);
		let current = object;
		for (
			let depth = 0;
			git(repo, ["cat-file", "-t", current]) === "tag";
			depth++
		) {
			if (remoteObjects.has(current)) break;
			if (depth >= 64) throw Error("tag chain exceeds bounded resolution");
			tagObjects.add(current);
			const next = /^object ([a-f0-9]+)$/m.exec(
				git(repo, ["cat-file", "tag", current]),
			)?.[1];
			if (!next || !OID.test(next)) throw Error("invalid tag object");
			current = next;
		}
	};
	for (const source of sources) add(source);
	if (followTags || config(repo, "push.followTags") === "true")
		for (const tag of refs(repo, "refs/tags/")) {
			const object = resolveObject(repo, tag),
				commit = commitOf(repo, object);
			if (!commit || git(repo, ["cat-file", "-t", object]) !== "tag") continue;
			if (
				[...tips].some(
					(tip) =>
						spawnSync("git", ["merge-base", "--is-ancestor", commit, tip], {
							cwd: repo,
						}).status === 0,
				)
			)
				add(tag);
		}
	if (!tips.size) return { logOptions: null, tagObjects: [...tagObjects] };
	const bases = [...remoteObjects].flatMap((object) => {
		const commit = commitOf(repo, object);
		return commit ? [commit] : [];
	});
	const revisionArgs = [
		...tips,
		...(bases.length ? ["--not", ...new Set(bases)] : []),
	];
	const outgoing = git(repo, ["rev-list", ...revisionArgs]);
	return {
		logOptions: outgoing
			? `--diff-merges=first-parent ${revisionArgs.join(" ")}`
			: null,
		tagObjects: [...tagObjects],
	};
}

export function scanPushSecrets(
	repo: string,
	args: string[],
): { ok: boolean; why?: string } {
	try {
		const selected = outgoingPushObjects(repo, args);
		if (selected.logOptions) {
			const result = spawnSync(
				"gitleaks",
				[
					"git",
					".",
					"--redact",
					"--no-banner",
					`--log-opts=${selected.logOptions}`,
				],
				{
					cwd: repo,
					encoding: "utf8",
					timeout: 120_000,
					maxBuffer: 4 * 1024 * 1024,
				},
			);
			if (result.status !== 0)
				return {
					ok: false,
					why: "gitleaks rejected outgoing commit history or could not complete its scan",
				};
		}
		for (const oid of selected.tagObjects) {
			const tag = git(repo, ["cat-file", "tag", oid]);
			const result = spawnSync(
				"gitleaks",
				["stdin", "--redact", "--no-banner"],
				{
					cwd: repo,
					input: tag,
					encoding: "utf8",
					timeout: 30_000,
					maxBuffer: 1024 * 1024,
				},
			);
			if (result.status !== 0)
				return {
					ok: false,
					why: "gitleaks rejected an outgoing tag annotation or could not complete its scan",
				};
		}
		return { ok: true };
	} catch {
		return {
			ok: false,
			why: "outgoing push scope could not be proven; resolve the remote/refspec before retrying",
		};
	}
}
