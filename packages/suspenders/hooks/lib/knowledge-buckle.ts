// Machine-local Buckle credential for the knowledge worker. The file is
// provisioned with a proxy-only key; it is never copied into the repo.
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";

export interface KnowledgeBuckleRoute {
	front: URL;
	token: string;
}

export function knowledgeBuckleRoute(
	env: NodeJS.ProcessEnv = process.env,
): KnowledgeBuckleRoute {
	let url = env.SUSPENDERS_BUCKLE_URL;
	let token = env.SUSPENDERS_BUCKLE_TOKEN;
	if ((url && !token) || (!url && token))
		throw new Error(
			"Buckle distill URL and scoped key must be configured together",
		);
	if (!url && env.HOME) {
		const path = join(env.HOME, ".claude/local-llm/knowledge-buckle.json");
		try {
			const stat = statSync(path);
			if (
				!stat.isFile() ||
				(stat.mode & 0o077) !== 0 ||
				stat.uid !== process.getuid()
			)
				throw new Error("knowledge-buckle.json must be mode 0600");
			const stored = JSON.parse(readFileSync(path, "utf8")) as {
				url?: string;
				token?: string;
			};
			url = stored.url;
			token = stored.token;
		} catch (error) {
			if (error instanceof Error && error.message.includes("must be mode"))
				throw error;
		}
	}
	if (!url || !token?.startsWith("bksk_"))
		throw new Error(
			"scoped Buckle distill route unavailable — jobs stay queued",
		);
	let front: URL;
	try {
		front = new URL(url);
	} catch {
		throw new Error("invalid Buckle distill URL — jobs stay queued");
	}
	if (
		!["http:", "https:"].includes(front.protocol) ||
		front.username ||
		front.password ||
		front.pathname !== "/" ||
		front.search ||
		front.hash
	)
		throw new Error("invalid Buckle distill URL — jobs stay queued");
	return { front, token };
}
