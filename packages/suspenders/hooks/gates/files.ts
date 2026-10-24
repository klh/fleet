// hooks/gates/files.ts — PostToolUse(Edit|Write|NotebookEdit): markdown format
// + code auto-format (qlty fmt) + syntax gate + blind-edit nudge in ONE process.
// 2026-09-15: syntax checking consolidated on QLTY ONLY (user directive —
// the tsc/esbuild/jq/yq/taplo/ruff/biome/sass per-type gates are gone).
// 2026-09-15 (owner: "learn from the formatting mistakes"): code files get
// `qlty fmt` ON SAVE, before the check — safe fixes land without a
// fix-it-yourself loop, and the agent is told to re-read when the file
// changed under it (same contract as the markdown/prettier path).
// Runs from the file's dir with the basename (absolute paths fail qlty's
// strip-prefix). Repos without qlty setup (exit 99) skip silently — run
// `qlty init -y && qlty plugins enable biome` there to get coverage.
// W14: the gate body lives in filesCheck() — exit-free — so stop.ts re-verifies
// changed files IN-PROCESS instead of spawning `bun gate.ts post-files` per file.
import { allow, context, feedback, type HookInput } from "../lib/hookio.ts";
import { oncePerSession } from "../lib/advisory-cooldown.ts";
import { bumpPathCount } from "../lib/gatestate.ts";
import { have, lines, run } from "../lib/run.ts";
import { openStore } from "../lib/govdb.ts";
import { drainLaneInbox } from "../lib/lane-inbox.ts";
import { basename, dirname } from "node:path";
import {
	existsSync,
	mkdirSync,
	readFileSync,
	realpathSync,
	writeFileSync,
} from "node:fs";
import { createHash } from "node:crypto";

/** Exit-free verdict of the files gate; filesGate maps kinds 1:1 to the old
 * exit behavior (ok→allow, context→additionalContext+exit 0, feedback→
 * stderr+exit 2, block→stderr+exit 2). */
export type FilesExit =
	| { kind: "ok" }
	| { kind: "context"; msg: string }
	| { kind: "feedback"; msg: string }
	| { kind: "block"; err: string };

export function filesGate(hook: HookInput): never {
	const v = filesCheck(hook);
	if (v.kind === "context") context(v.msg, "PostToolUse");
	if (v.kind === "feedback") feedback(v.msg);
	if (v.kind === "block") {
		process.stderr.write(v.err);
		process.exit(2);
	}
	allow();
}

export function filesCheck(hook: HookInput): FilesExit {
	if (!["Edit", "Write", "NotebookEdit"].includes(hook.tool_name ?? ""))
		return { kind: "ok" };
	const F = hook.tool_input?.file_path ?? hook.tool_input?.notebook_path ?? "";
	if (!F) return { kind: "ok" };

	const isMd = /\.(md|markdown)$/i.test(F);
	const isCode = /\.(ts|tsx|js|jsx|mjs|cjs|json|jsonc)$/i.test(F);
	const notes: string[] = [];
	const sid = hook.session_id;

	// ---- UI law (owner 2026-10-01, CLAUDE.md): NEVER innerHTML/document.write
	// anywhere; document.createElement(NS) only inside web components (lit) ----
	if (isCode) {
		const payload = String(
			hook.tool_input?.content ?? hook.tool_input?.new_string ?? "",
		);
		if (payload) {
			const wcMark = /["'][^"']*lit["']|@customElement|customElements\.define/;
			const isWc =
				wcMark.test(payload) ||
				(existsSync(F) && wcMark.test(readFileSync(F, "utf8")));
			if (/innerHTML|document\.write\s*\(/.test(payload))
				return {
					kind: "block",
					err: `UI LAW: innerHTML/document.write are NEVER allowed — rewrite as lit-html templates in a web component. ${F}\n`,
				};
			if (
				!isWc &&
				/document\.createElement\s*\(|createElementNS\s*\(/.test(payload)
			)
				return {
					kind: "block",
					err: `UI LAW: document.createElement / createElementNS only inside web components (import lit / @customElement). ${F}\n`,
				};
			// W869: the recurring lint classes (AGENTS.md "recurring offenders")
			// refuse the write deterministically — qlty-independent, so the
			// refusal survives a gate process without qlty on PATH. Agents emit
			// them clean when the refusal is at write time, not at stop/merge.
			const promoted = promotedClassViolation(F, payload);
			if (promoted) {
				refreshLeaseHash(F); // W58: bless before a block, next edit re-claims
				return {
					kind: "block",
					err: `W869 PROMOTED CLASS (write-time block): ${promoted}\nFix this now before continuing.\n`,
				};
			}
		}
	}

	// Worktree lanes (multi-agent): SKIP per-save formatting. The fmt mutates
	// the file after the governor hashed it and every cycle risks a lost-update
	// deny on the shared registry — 4.8K false "changed on disk" retries in the
	// gaps session. Formatting happens once at claim-done: stop.ts re-runs this
	// gate with _deferred_fmt=true (syntax check still runs per-save).
	const deferFmt =
		/\/(?:\.claude\/worktrees|\.worktrees)\//.test(F) &&
		(hook as HookInput & { _deferred_fmt?: boolean })._deferred_fmt !== true;

	// ---- markdown: prettier (GFM, prose preserved) ----
	if (isMd && !deferFmt && existsSync(F) && have("prettier")) {
		const before = Bun.hash(readFileSync(F));
		run("prettier", [
			"--write",
			"--prose-wrap",
			"preserve",
			"--log-level",
			"warn",
			F,
		]);
		if (Bun.hash(readFileSync(F)) !== before) {
			recordGateWrite(F); // W58: the gate's own rewrite, self-declared
			refreshLeaseHash(F);
			// W645 advisory cooldown: identical notes (same file, same rewrite)
			// repeat on every save — content-keyed 5-min per-session TTL,
			// fail-open; steer delivery below is directed content, never cooled.
			const mdNote = oncePerSession(
				sid,
				`md-format: normalized ${F}. Read the updated file only if editing it again.`,
			);
			if (mdNote) notes.push(mdNote);
		}
	}

	// ---- code: qlty fmt ON SAVE, then the syntax gate ----
	if (isCode && existsSync(F)) {
		const fmtNote = deferFmt ? null : qltyFmt(F);
		if (fmtNote) recordGateWrite(F); // W58: the gate's rewrite, declared BEFORE any verdict
		const issues = qltyGate(F, deferFmt);
		if (issues) {
			// W58: bless fmt's rewrite + the sanctioned write BEFORE blocking —
			// returning with a stale lease hash denies the agent's next edit
			// (the lived "every other edit trips the hash guard" loop).
			refreshLeaseHash(F);
			const head = fmtNote ? `${fmtNote} Re-read before further edits.\n` : "";
			return {
				kind: "block",
				err: `${head}qlty check found issues in ${F}:\n${issues.slice(0, 4000)}\nFix this now before continuing.\n`,
			};
		}
		if (fmtNote) {
			refreshLeaseHash(F);
			const fmtNoteMsg = oncePerSession(
				sid,
				`${fmtNote} Read the updated file only if editing it again.`,
			);
			if (fmtNoteMsg) notes.push(fmtNoteMsg);
		}
	}

	// ---- W92.4 govdb-import rule: openGovernorDb is store-owner-only. Gates
	// ride openStore() (this item retired the gates from the grandfather list);
	// grandfathered consumers soft-note, NEW direct imports hard-block. ----
	if (isCode && F.includes("/hooks/") && existsSync(F)) {
		const violation = govdbImportViolation(F, readFileSync(F, "utf8"));
		if (violation) {
			refreshLeaseHash(F);
			const err = `W92 govdb-import rule: ${F} ${violation.msg}\nConsumers bind via openStore() (hooks/lib/govdb.ts) — in-process SQLite by default, the store port when GOVERNOR_STORE_URL/store.url is set. Store owners are listed in govdbImportViolation().\n`;
			if (violation.soft) return { kind: "context", msg: err };
			return { kind: "block", err };
		}
	}

	// ---- settings.json guard (the ONE exception to qlty-only — qlty has no
	// JSON plugin, and a broken settings.json silently disables all settings;
	// user-approved 2026-09-15). jq, ~3ms; basename match covers project copies.
	if (basename(F) === "settings.json" && existsSync(F)) {
		const r = run("jq", ["empty", F]);
		if (!r.ok) {
			refreshLeaseHash(F); // W58: same blessing before a block
			return {
				kind: "block",
				err: `INVALID JSON in ${F}:\n${lines(r.out, 3)}\nFix this now before continuing.\n`,
			};
		}
	}

	// W157 (law.ts-1500-decompose): a .ts past 1500 lines is decompose
	// territory. The W157 backlog (fleet-board / coord / board-html / its
	// test) landed 2026-10-01, so this ships as a hard block — the brief's
	// WARN grace phase collapsed into the flip in this same landing.
	// Near-cap law (W744, AGENTS.md "1500-Line Hard Limit"): a .ts above
	// ~1200 lines is NEAR-CAP — patch-only anchored edits, new content in
	// its own file, and the done-gate verifies the diff shape (churn > 300
	// refuses closure unless the item IS a decomposition).
	if (F.endsWith(".ts") && existsSync(F)) {
		const n = readFileSync(F, "utf8").split("\n").length;
		if (n > 1500)
			return {
				kind: "block",
				err: `1500-LINE LIMIT: ${basename(F)} is ${n} lines (law.ts-1500-decompose, AGENTS.md "1500-Line Hard Limit"; near-cap 1200 = patch-only, W744). Decompose into single-purpose modules before the next write — pattern: hooks/board/, hooks/coord/, hooks/board-html/ (W157).\n`,
			};
	}

	// The sanctioned WRITE itself is the lease's new ground truth (owner
	// 2026-09-22: the governor integrates): refresh on every successful
	// edit — not only when a formatter happened to change more — so the
	// lease owner's NEXT edit never sees the edit's own delta as foreign.
	if (existsSync(F)) refreshLeaseHash(F);

	const streak = editStreak(hook, F);
	if (streak?.kind === "block") return streak;
	if (streak?.kind === "context") {
		const streakMsg = oncePerSession(sid, streak.msg);
		if (streakMsg) notes.push(streakMsg);
	}
	// W611 steer delivery: undelivered directed events (target = this lane's
	// sid, past the cursor) ride out as additionalContext on EVERY save — the
	// one moment a busy lane's PostToolUse is guaranteed to reach the model.
	// Fail-open inside; the cursor advances past SHOWN, never blocks.
	const steer = drainLaneInbox(hook);
	if (steer) notes.push(steer);
	if (notes.length) return { kind: "context", msg: notes.join("\n") };
	return { kind: "ok" };
}

// ---- W92.4: who may open governor.db directly ------------------------------
// Store owners: the schema module (lib/govdb.ts), the HTTP face
// (bin/store-server.ts), the W91 knowledge adapter (its declared only-place).
// GRANDFATHERED names consumers whose port migration is a separate child's
// scope — each migrates to openStore() and LEAVES this list; the rule bans
// NEW direct imports the moment a file is written. The original list (W92
// first attempt, d4ba6478) died with that implementation; this one starts
// with the gates already retired off it.
const STORE_OWNERS = [
	// W624 decomposition — the owner code moved into these siblings; the
	// entrypoint govdb.ts is now a pure re-export shim over them.
	"/lib/govdb.ts",
	"/lib/govdb-open.ts",
	"/lib/govdb-store.ts",
	"/bin/store-server.ts",
	"/lib/knowledge-ports.ts",
];
const GRANDFATHERED = [
	// W92.3's in-flight scope — these leave the list when that child lands.
	"/bin/fleet-loop.ts",
	"/bin/monitor.ts",
	"/bin/harvest.ts",
	"/bin/claim.ts",
	"/bin/worktree.ts",
	// consumers outside the W92 children's scopes — one line each when their
	// migration child lands
	"/bin/activity-harvest.ts",
	"/bin/aid-harvest.ts",
	"/bin/console-repo-law.ts",
	"/bin/consult-relay.ts",
	"/bin/federation-pull.ts",
	"/bin/fleet-mcp.ts",
	"/bin/lifecycle-authority.ts",
	"/bin/metrics-alert.ts",
	"/bin/policy-workflow.ts",
	"/bin/quota-sweep.ts",
	"/bin/session-policy.ts",
	"/lib/decomposition.ts",
	"/lib/lane-completion.ts",
	"/lib/lane-inbox.ts",
	"/lib/settle.ts",
];

/** Null = fine; otherwise the verdict. Owners pass silently, grandfathered
 * consumers pass with a soft note (migrate, don't extend), ANY other hooks/
 * module with a direct DB import hard-blocks: that is a NEW direct import,
 * exactly what W92 bans. */
export function govdbImportViolation(
	F: string,
	content: string,
): { msg: string; soft: boolean } | null {
	if (F.includes("/test/") || F.includes("/spikes/") || F.includes("/sim/"))
		return null;
	const path = `/${F.split("/hooks/").pop() ?? ""}`; // repo + installed prefix share the /hooks/ layout
	const usesDb =
		/import\s*\{[^}]*openGovernorDb[^}]*\}\s*from/.test(content) ||
		/\bopenGovernorDb\s*\(/.test(content);
	if (!usesDb) return null;
	if (STORE_OWNERS.some((s) => path.endsWith(s))) return null;
	if (GRANDFATHERED.some((s) => path.endsWith(s)))
		return {
			msg: "still imports the DB directly (grandfathered — migrate to the store port; do not ADD call sites)",
			soft: true,
		};
	return {
		msg: "imports the DB directly — store owners only",
		soft: false,
	};
}

// ---- W869 promoted lint classes: deterministic write-time refusal ----------
// The two recurring offenders AGENTS.md names (noNonNullAssertion,
// useLiteralKeys) no longer wait for a completion that never runs outside
// worktrees: the emitted payload itself is checked, qlty or no qlty.
// Regexes match the shapes biome flags — postfix `!` before member/call
// access; quote-keyed computed access/keys whose key is a valid identifier
// (biome's own scope — numeric ["0"] and dashed ["a-b"] keys never fire).

const IDENT_KEY = /^[A-Za-z_$][\w$]*$/;
const NON_NULL = /[\w$)\]]!(?=[.([])/;
const LIT_ACCESS = /[\w$)\]]\s*\[\s*(['"])((?:\\.|(?!\1).)*)\1\s*\]/;
const LIT_KEY = /[,{]\s*\[\s*(['"])((?:\\.|(?!\1).)*)\1\s*\]\s*:/;

/** First promoted-class violation, `rule — F:line: <line text>`, else null. */
export function promotedClassViolation(
	F: string,
	payload: string,
): string | null {
	if (!/\.(ts|tsx|js|jsx|mjs|cjs)$/.test(F)) return null;
	const rows = payload.split("\n");
	for (let i = 0; i < rows.length; i++) {
		const line = rows[i];
		if (NON_NULL.test(line))
			return `biome:lint/style/noNonNullAssertion — non-null assertion at ${F}:${i + 1}: ${line.trim().slice(0, 160)}`;
		// `x as ["a"]` is a type-position tuple, not member access
		const m = LIT_ACCESS.exec(line);
		if (m) {
			const before = line.slice(0, (m.index ?? 0) + 1);
			const word = /([A-Za-z_$][\w$]*)\s*$/.exec(before)?.[1] ?? "";
			if (word !== "as" && word !== "satisfies" && IDENT_KEY.test(m[2]))
				return `biome:lint/complexity/useLiteralKeys — computed string-key access at ${F}:${i + 1}: ${line.trim().slice(0, 160)}`;
		}
		const k = LIT_KEY.exec(line);
		if (k && IDENT_KEY.test(k[2]))
			return `biome:lint/complexity/useLiteralKeys — computed string-key object property at ${F}:${i + 1}: ${line.trim().slice(0, 160)}`;
	}
	return null;
}

/** `qlty fmt` in place. Returns a note when the file changed, null otherwise.
 * Repos without qlty setup (exit 99) skip silently — never blocks. */
function qltyFmt(F: string): string | null {
	if (!have("qlty")) return null; // no qlty on PATH (CI) — skip like an unsetup repo
	const before = Bun.hash(readFileSync(F));
	const proc = Bun.spawnSync(
		["qlty", "fmt", "--no-upgrade-check", basename(F)],
		{
			cwd: dirname(F),
			stdout: "pipe",
			stderr: "pipe",
		},
	);
	if (
		proc.exitCode === 99 ||
		/must be set up/i.test(`${proc.stdout}${proc.stderr}`)
	)
		return null;
	if (!existsSync(F)) return null; // TOCTOU: gone mid-fmt
	return Bun.hash(readFileSync(F)) !== before
		? `qlty-fmt: auto-fixed ${F} on save.`
		: null;
}

/** `qlty check` — returns the issues text, or null when clean/skipped. */
function qltyGate(F: string, deferFmt: boolean): string | null {
	if (!have("qlty")) return null; // Bun.spawnSync THROWS on a missing binary — the old
	// process-level fail-open swallowed this; in-process filesCheck must skip instead
	const stillThere = () => existsSync(F);
	const proc = Bun.spawnSync(
		[
			"qlty",
			"check",
			"--no-upgrade-check",
			...(deferFmt ? ["--no-formatters"] : []),
			basename(F),
		],
		{
			cwd: dirname(F),
			stdout: "pipe",
			stderr: "pipe",
		},
	);
	const out = `${proc.stdout}${proc.stderr}`.trim();
	// exit 99 = "Qlty must be set up in this repository" — skip silently
	if (proc.exitCode === 99 || /must be set up/i.test(out)) return null;
	return proc.exitCode !== 0 && stillThere() ? out : null;
}

// Count edits per file per session; every 3rd edit nudges to verify
// (CLAUDE.md blind-edit rule: run/build/test before editing further).
function editStreak(hook: HookInput, F: string): FilesExit | null {
	const sid = hook.session_id;
	if (!sid) return null;
	const n = bumpPathCount("edits", sid, F);
	if (n % 3 !== 0) return null;
	const label = F.slice(F.lastIndexOf("/") + 1);
	// 2026-09-28, owner: the verify-every-3rd-edit nag was ignored all day
	// while interleaved edits + autofixes corrupted files twice — the gate
	// now runs the build ITSELF at 3/6/9 and blocks with the compiler error.
	// TS only (json/md have no build); bun build ~100ms; fail-open on spawn
	// trouble (the streak counter is advisory state, never a hard gate).
	if (/\.(ts|tsx|mjs)$/.test(F) && existsSync(F)) {
		const build = Bun.spawnSync(
			[process.execPath, "build", "--target=bun", F, "--outfile", "/dev/null"],
			{ stdout: "pipe", stderr: "pipe" },
		);
		const err = build.stderr ? new TextDecoder().decode(build.stderr) : "";
		if (build.exitCode !== 0) {
			return {
				kind: "block",
				err: `Edit #${n} to ${label}: the gate built it and it FAILS — fix before editing further.\n${err.slice(0, 2000)}\n`,
			};
		}
	}
	return {
		kind: "context",
		msg: `Edit #${n} to ${label} — build verified clean by the gate.`,
	};
}

/** Governor interplay: a post-tool write (prettier/qlty-fmt) mutated the file
 * AFTER the governor recorded its hash — refresh the lease hash AND record the
 * observed hash in the lease's seen ring, so the owner's next edit is allowed
 * outright and a same-session retry BLESSES the write instead of denying
 * (owner 2026-09-22: the governor integrates; it only prevents blind
 * concurrent write errors). Never blocks. Lease state lives in governor.db
 * (SQLite/WAL) — busy_timeout arbitrates against concurrent gate processes. */
function refreshLeaseHash(F: string): void {
	try {
		const db = openStore();
		const rp = existsSync(F) ? realpathSync(F) : F;
		const row = db
			.query("SELECT path, seen FROM locks WHERE path = ? OR path = ?")
			.get(F, rp) as { path: string; seen: string | null } | undefined;
		if (!row) {
			db.close();
			return;
		}
		const h = createHash("sha256")
			.update(readFileSync(F))
			.digest("hex")
			.slice(0, 16);
		let seen: string[] = [];
		try {
			seen = row.seen ? (JSON.parse(row.seen) as string[]) : [];
		} catch {}
		seen = [...new Set([...seen, h])].slice(-5);
		db.query("UPDATE locks SET hash = ?, seen = ? WHERE path = ?").run(
			h,
			JSON.stringify(seen),
			row.path,
		);
		db.close();
	} catch {
		// registry write failure must never block — fail open
	}
}

// ---- gate-write journal (W58: single-writer fmt, self-declared rewrites) ----
// The PostToolUse fmt rewrite mutates the file AFTER the pre-files governor
// hashed it, so the governor's content-version check (gates/governor.ts) must
// be able to tell that rewrite from a FOREIGN write. The lease's `seen` ring
// covers the same-lane case; this journal is the durable, cross-lane paper
// trail: every gate rewrite appends {path, sha256, ts}, capped at the last
// 500 lines. CONSUMED BY (integration site — another lane's file): the deny
// branch of the content-version check in gates/governor.ts — a hash mismatch
// where gateWroteSince(P, now − 60s) is true is the gate's OWN rewrite, not an
// outside write, and should bless (UPDATE locks.hash + seen, return) exactly
// like the seen-ring hit one branch above it. Fail-open: an unreadable
// journal never changes a verdict.
export const GATE_WRITES_JOURNAL = `${process.env.HOME ?? ""}/.cache/claude-governor/gate-writes.jsonl`;

/** SUSPENDERS_GATE_WRITES relocates the journal (tests, CI, per-repo runs). */
function journalPath(): string {
	return process.env.SUSPENDERS_GATE_WRITES ?? GATE_WRITES_JOURNAL;
}

/** True when the gate journaled a rewrite of `path` at/after ISO `isoTs` —
 * the bless the governor's content-version check consumes INSTEAD of denying.
 * Unreadable journal / malformed lines → false: behave exactly as today
 * (deny on hash mismatch). */
export function gateWroteSince(path: string, isoTs: string): boolean {
	try {
		const rp = existsSync(path) ? realpathSync(path) : path;
		const raw = readFileSync(journalPath(), "utf8");
		for (const line of raw.split("\n")) {
			if (!line) continue;
			try {
				const e = JSON.parse(line) as {
					path?: string;
					sha256?: string;
					ts?: string;
				};
				if (!e.path || !e.ts) continue;
				if (e.path !== path && e.path !== rp) continue;
				if (e.ts >= isoTs) return true; // ISO-8601 UTC compares lexicographically
			} catch {}
		}
	} catch {}
	return false;
}

/** Journal the gate's own rewrite (W58): path + sha256 (the same 16-char form
 * the governor stores in locks.hash) + ISO ts. Appending is wrapped so a
 * journal failure must never change the gate's verdict — fail open. */
export function recordGateWrite(F: string): void {
	try {
		const sha = existsSync(F)
			? createHash("sha256").update(readFileSync(F)).digest("hex").slice(0, 16)
			: null;
		if (!sha) return;
		const p = journalPath();
		let merged = `${JSON.stringify({ path: F, sha256: sha, ts: new Date().toISOString() })}\n`;
		try {
			const old = readFileSync(p, "utf8");
			merged = (old.endsWith("\n") || old === "" ? old : `${old}\n`) + merged;
		} catch {}
		const capped = merged
			.split("\n")
			.filter((l) => l !== "")
			.slice(-500);
		mkdirSync(dirname(p), { recursive: true });
		writeFileSync(p, `${capped.join("\n")}\n`);
	} catch {
		// journal failure must never block — fail open
	}
}
