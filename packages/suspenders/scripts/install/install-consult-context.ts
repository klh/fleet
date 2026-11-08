// scripts/install/install-consult-context.ts — W2863 faces (b)(d)(e): the
// consult-knowledge snippet as a MANAGED BLOCK in each CLI's persistent
// context file — ~/.pi/agent/AGENTS.md, ~/.codex/AGENTS.md,
// ~/.claude/CLAUDE.md. Managed-block law: content outside the markers is
// never touched (user-curated context files), the block is replaced
// idempotently on re-runs, and the block carries what pi's tabula-rasa
// witness run proved undiscoverable: peer discovery (coord targets), the
// ask/message/ack recipes with --as <me>, WS-first delivery (W303), the
// knowledge-sink query shape, and the no-peer-CLI-bypass rule.
import {
	existsSync,
	lstatSync,
	mkdirSync,
	readFileSync,
	writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";

export const CONSULT_BLOCK_START = "<!-- fleet:consult-plane:v1 -->";
export const CONSULT_BLOCK_END = "<!-- /fleet:consult-plane:v1 -->";

export const CONSULT_CONTEXT_BLOCK = `${CONSULT_BLOCK_START}
## Fleet consult plane (install-managed block)

- My lane id: the SESSION/lane line the fleet bootstrap rendered for THIS session — use it as \`--as <me>\` everywhere below.
- Peers + names/sids: \`coord targets\` / \`coord fleet\` — never guess a sid; resolve by name when a durable one exists (\`<cli>@<host>\`).
- Ask a peer: \`coord consult <sid-or-name> "<q>" --as <me>\`; answers push back over the live WS subscribe (W303 — never poll). Bounded wait: \`coord wait --as <me> --kinds consult.answer --max-seconds 30\`.
- Deliver to an INACTIVE target: \`coord message <sid> "<note>" --as <me>\` — delivers on resume, unaccepted until acked.
- Act, then ack: \`coord ack <event-id> --as <me>\` (bare id, no \`#\`). An answer to YOUR consult closes the loop: \`coord consult-reply <C##> --feedback resolved|failed --evidence ...\`.
- Knowledge before re-deriving: \`coord fact get <lesson.*|finding.*>\` (coord fact get falls through to the machine knowledge sink when unset). Sink shape when conf resolves it: \`curl -s $SUSPENDERS_KNOWLEDGE_SINK_URL/search -X POST -H 'content-type: application/json' -d '{"query":"..."}'\` (bearer: SUSPENDERS_KNOWLEDGE_KEY or the 0600 SUSPENDERS_KNOWLEDGE_KEY_FILE).
- NEVER bypass the plane by shelling out to peer CLIs (codex exec / claude -p / pi …): bypasses dodge attribution, spawn rogue processes, and cannot be consulted back.
${CONSULT_BLOCK_END}`;

export type ConsultContextResult = {
	status: "ok" | "planned";
	wrote: string[];
	kept: string[];
	failed: string[];
	note: string;
};

function upsertBlock(
	path: string,
	dryRun: boolean,
): "wrote" | "kept" | "planned" {
	if (!existsSync(path)) {
		if (dryRun) return "planned";
		mkdirSync(dirname(path), { recursive: true });
		writeFileSync(path, `${CONSULT_CONTEXT_BLOCK}\n`, { mode: 0o644 });
		return "wrote";
	}
	if (lstatSync(path).isSymbolicLink()) {
		throw new Error(`refusing symlink: ${path}`);
	}
	const raw = readFileSync(path, "utf8");
	if (raw.includes(CONSULT_BLOCK_START)) {
		const open = raw.indexOf(CONSULT_BLOCK_START);
		const close = raw.indexOf(CONSULT_BLOCK_END);
		if (close < open) throw new Error(`unbalanced managed block in ${path}`);
		if (dryRun) return "kept";
		writeFileSync(
			path,
			raw.slice(0, open) +
				CONSULT_CONTEXT_BLOCK +
				raw.slice(close + CONSULT_BLOCK_END.length),
		);
		return "kept";
	}
	if (dryRun) return "planned";
	const sep = raw.endsWith("\n\n") ? "" : raw.endsWith("\n") ? "\n" : "\n\n";
	writeFileSync(path, `${raw}${sep}${CONSULT_CONTEXT_BLOCK}\n`);
	return "wrote";
}

export function installConsultContext(
	options: {
		home?: string;
		piHome?: string;
		codexHome?: string;
		claudeHome?: string;
		dryRun?: boolean;
	} = {},
): ConsultContextResult {
	const home = options.home ?? process.env.HOME ?? "";
	const targets: Array<[string, string]> = [
		["pi", join(options.piHome ?? join(home, ".pi/agent"), "AGENTS.md")],
		["codex", join(options.codexHome ?? join(home, ".codex"), "AGENTS.md")],
		["claude", join(options.claudeHome ?? home, ".claude/CLAUDE.md")],
	];
	return finishConsultContext(options, targets);
}

function finishConsultContext(
	options: { dryRun?: boolean },
	targets: Array<[string, string]>,
): ConsultContextResult {
	const wrote: string[] = [];
	const kept: string[] = [];
	const failed: string[] = [];
	const perFile: Array<[string, string]> = [];
	for (const [cli, path] of targets) {
		try {
			const outcome = upsertBlock(path, options.dryRun ?? false);
			if (outcome === "wrote") wrote.push(path);
			else if (outcome === "kept") kept.push(path);
			perFile.push([cli, `${outcome} ${path}`]);
		} catch (e) {
			failed.push(
				`${cli}:${path}: ${e instanceof Error ? e.message : String(e)}`,
			);
		}
	}
	return {
		status: options.dryRun ? "planned" : "ok",
		wrote,
		kept,
		failed,
		note: perFile.map(([c, n]) => `${c}=${n}`).join("; "),
	};
}

if (import.meta.main) {
	if (process.argv.includes("--help")) {
		console.log("usage: bun install-consult-context.ts [--dry-run]");
	} else {
		const r = installConsultContext({
			dryRun: process.argv.includes("--dry-run"),
		});
		console.log(
			`Consult context blocks: ${r.wrote.length} written, ${r.kept.length} kept, ${r.failed.length} failed`,
		);
		for (const f of r.failed) console.error(f);
	}
}
