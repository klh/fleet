# W1134 — Nimbalyst agent-authored wiki + Context Graph vs fleet's knowledge layer

Date 2026-10-22 · lane `autow1134-p98b319584008df14` · item W1134 · the decision
record for "lift or reject". Sources: nimbalyst.com (home, wiki, wiki-teams,
context-graph, features, docs, harness) — full-page captures banked as
scrub-clean `.txt` under `.fleet-survey/` (this branch), read in full for this
survey. Fleet-side ground truth verified in-repo: `kb.knowledge` schema
(`packages/suspenders/hooks/lib/govdb-knowledge.ts:69`), board decision
endpoints (`packages/suspenders/hooks/bin/fleet-board.ts:2` —
`/api/decisions` `/api/answer` `/api/ack`), decant as vendored transcript
analytics (`docs/decant-crosscheck-2026-10-19.md`).

## Premise correction

The item description calls decant "the periodic distillation of session
transcript into curated docs". The repo disagrees: decant is the vendored
(dosu-ai/decant, Apache-2.0) transcript **analytics** engine — token recounts
and attribution cross-checks (W943), not a doc surface. The curated/reviewed/
law-backed role the description attributes to decant is actually played by:

- `AGENTS.md` (static law, human-authored),
- `docs/design/*` decision records (like this one),
- coord facts with the `state` machine (`candidate` → `active` needs human
  review; corrections are new rows via `supersedes_id`) — the W142
  verified-only arch,

and the raw payloads live in work-graph events. This correction reshapes the
recommendation: there is no decant cadence to "extend"; the comparison is
Nimbalyst vs facts + law + decision records + board.

## What Nimbalyst actually ships (from the captures)

- **Wiki**: markdown pages in the repo (git-ignorable or checked in), written
  by the agent. `capture` at session end writes each decision into the page it
  affects with who decided, when, and what was passed over; open questions get
  owners. `recall` answers "why did we…" from the wiki. Session start tells
  the agent what the wiki covers and which pages cover the changed files.
  Typed pages (competitors, customers, features) with per-item pages + a
  table. Browser editor, local-first, token-protected.
- **Wiki Teams**: the same wiki multiplayer on Nimbalyst-hosted Cloudflare
  (console.nimbalyst.com), live cursors, every teammate's agents write in; a
  "graph underneath" where an agent follows links from a changed page to
  update connected pages.
- **Context Graph**: every artifact — tracker item, plan, spec, diagram,
  mockup, thread, session, diff, files, commit — is a node; relationships are
  typed edges; one traversal pulls a session's related plan/spec/session/
  files. Framed as the "provenance" layer of their 8-layer agent harness
  (context, provenance, capability, workflow, restraint, verification, visual
  interface, coordination).

## Comparison table

| Dimension                  | Nimbalyst                                                     | Fleet today                                                                                        |
| -------------------------- | ------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| Who writes the record      | The agent, during/end of each session (`capture`)             | The lane, at boundaries — capsules, `work done --summary`, `fact set finding.*` (mandated landing step 3) |
| Where it lives             | Markdown pages in the repo; optional hosted Teams copy        | governor.db/knowledge.db (facts), work events, `docs/design/*`, `AGENTS.md` law                    |
| Human-editable             | Yes — first-class (pages are files; browser editor)           | Facts: no (CLI-mutated rows); law/docs: yes but static                                            |
| Decision record shape      | Per-decision block in the affected page: who/when/what was passed over | Work item + `work done` summary + NEED_DECISION events (`task_id`, options)                       |
| Open questions surfaced    | Index page + team home "questions waiting on the team"        | Board decisions tab W157: OPEN → ANSWERED → ACKNOWLEDGED with task_id + options                    |
| Relationship typing        | Typed edges between every artifact kind (the Context Graph)   | `duplicate_of`/`supersedes_id`/`superseded_by` **within** facts only; `domain`/`area` as loose tags |
| Recall into new sessions   | Session-start brief: what the wiki covers, pages for changed files | SessionStart hook: owned items, inbox, lessons (facts `lesson.*`)                                  |
| Trust gate                 | "A note earns its place when a strong model would get it wrong without it" (rhetoric, not enforced) | Enforced: verified-only (W142), `state` machine, `source_ref`/`source_hash`, scrub gate           |
| Multiplayer                | Wiki Teams (hosted, realtime, agents write too)               | Board (LAN :7799, write-token) + coord plane; ChatGPT ingress = coord only (W931)                  |
| Session-end capture prompt | Plugin reminder fires every session end                       | Capsule protocol at work-unit boundaries (discipline, not a plugin hook)                           |

## The four questions

**Q1 — does agent-authored living documentation beat post-hoc decant
cadence?** Framing fails; there is no decant cadence to beat (premise
correction above). The real comparison: Nimbalyst's `capture` (session end)
vs fleet's boundary capsules + mandated `finding.*` fact + `work done
--summary`. They are the same shape — structured records appended DURING
work — and the work-graph events already carry the payloads. The gap is
rendering, not capture: a per-item human-readable decision log does not
exist. **Lift the rendering, not a capture habit.**

**Q2 — Context Graph vs flat facts: worth a schema extension?** Not now.
`kb.knowledge` already holds intra-table relations (`duplicate_of`,
`supersedes_id`, `superseded_by`) plus `domain`/`area`, FTS5, and the
`coord consult`/`who-knows` ask surface. Nimbalyst's typed edges earn their
keep by connecting DIFFERENT artifact kinds (item↔spec↔session↔diff); fleet's
equivalents already link by convention: facts carry `origin_sid` → claim
windows → item id; `source_ref` points at files. A `knowledge_edges` table
would formalize what convention already resolves, and no consult-miss
evidence shows traversal failures today. Revisit only when a measured miss
exists (a consult the graph would have answered and FTS did not).

**Q3 — multiplayer wiki surface for the ChatGPT co-supervisor + owner?**
Rejected as a wiki. The board decisions tab already gives browser-based
OPEN/ANSWERED/ACKNOWLEDGED with a write-token gate (W157); ChatGPT's ingress
is coord-only by owner law (W931); and prose pages would be a NEW
authenticated write surface with audit burden whose content is already
covered by `AGENTS.md` (checked into the repo, human-edited via git) and
decision records. Nimbalyst Teams' genuine novelty — agents updating linked
pages when a decision changes — has no fleet analog, but nothing needs it
today.

**Q4 — what does the fleet layer already cover better?** Curation and trust:
Nimbalyst's "a note earns its place" is editorial rhetoric; fleet enforces it
(`state` machine, `source_hash`, scrub gate, verified-only). Law:
`AGENTS.md` is versioned law, not wiki prose. Attribution: every decision
record carries its lane, model, effort, consult flags (W776) — Nimbalyst has
nothing comparable. Provenance: the work graph + commit shas ARE the typed
edges the Context Graph sells, just not rendered as one.

## Lift-list

1. **Decision-log view (the one real lift) — rides the BOARD, not a wiki.**
   Per-item rendering over existing payloads: `work.done` summaries +
   `NEED_DECISION` events + `finding.*` facts stitched into one
   human-readable "what happened and why" column/section on the item view.
   No new capture habit, no new store — a read-only projection (the mission
   pre-saw this: "a wiki-view over them is a rendering problem").
2. **Auto-stamped decision pages from `work.done`** — already exists in
   embryo: the landing chain mandates `coord fact set finding.<item>` and
   `work done --summary`; the capsule protocol already banks who/what/next.
   Cheap extension: let the done-gate compose the `finding.*` text from the
   capsule when the lane omits it, so every closed item lands its
   one-line record (Nimbalyst's capture discipline, mechanically).
3. **Open-question owners** — Nimbalyst records an owner per open question.
   NEED_DECISION events carry `--to` (target sid), but the decisions tab
   shows no owner column. Trivial board addition if the owner ever asks.

## Reject-list

- **A fleet wiki (persistent human-editable pages)**
  — content already lives in `AGENTS.md`, `docs/design/*`, facts; a second
  prose store splits truth, needs its own auth/audit surface, and violates
  centralized-ledger law (the work graph + repo are the ONE ledger).
- **Context Graph schema extension (`knowledge_edges`)** — no measured
  consult-miss; `duplicate_of`/`supersedes_id` + `domain`/`area` + FTS5
  resolve today's traversals; graph-for-graph's-sake.
- **Wiki-Teams-style multiplayer pages for ChatGPT + owner** — W931 pins
  ChatGPT ingress to the coord plane; the decisions tab covers the browser
  need with a stricter trust gate.
- **Session-start "what the wiki covers" brief** — fleet's SessionStart hook
  already surfaces owned items + lessons + inbox; adding wiki coverage would
  re-double-spend the doc-covered-ground cost the W94 A/B measured (+45%
  tokens).
- **Nimbalyst adoption of any kind** — MIT-licensed and good, but the fleet
  stack is the harness; the captures stay as reference under `.fleet-survey/`.

## Recommendation

Neither "ride decant" nor "new board tab" — decant is analytics (nothing to
extend), and the decisions tab already exists. Land the **decision-log view
as a read-only projection on the existing board item view**, and the
**done-gate `finding.*` auto-compose** as its only two follow-ups. Both are
rendering/store-discipline moves over existing payloads; no schema, no new
surface, no capture habit change. If the owner wants a human-editable
surface for themselves, the answer is the repo (`AGENTS.md`, `docs/design/*`)
— not a wiki.

VERDICT: PASS — survey complete, lift-list (decision-log board view + done-gate finding auto-compose + decision-owner column) and reject-list (fleet wiki, knowledge_edges schema, multiplayer pages, wiki-coverage brief, adoption) are the decision record; follow-ups mint at owner GO only.
