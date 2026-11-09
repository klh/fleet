# Fleet Cockpit TUI — design

Date: 2026-11-09 · Owner ask: tabs like Copilot at the top of the pi TUI, fleet
lanes on the right side sorted by hub with activity sparklines, cockpit for
local + remote workers, rights-gated interaction.

## 1. Product frame

The pi TUI becomes a fleet cockpit with two jobs, per owner:

1. See **local work happening** and how it is distributed across work items.
2. See **remote workers** across hubs, their status updates and work — and
   fiddle with them (steer, wake, park, ack, peek).

Workers are the entities; hubs are **resources** (compute and inference
lenses), never containers. A worker may run in azure with no hub at all, and
its inference can hop hubs mid-life. The only true containment is **origin**
(who owns the worker's lifetime). Dimensions per worker:

| Dimension | Values | Role in UI |
|---|---|---|
| **Origin/lifetime** | `local` ◆ (this session) / `remote` ▣ (controller, service, other owner) | the ONLY tree-root split; local dies with the machine, remote persists |
| **Compute location** | `loc:` muramasa / docker-desktop / azure/eastus / nas / … | column on every row; may name no fleet hub |
| **Inference backing** | `via <hub>/<model>` legs | expandable children; can CHANGE over the worker's life |
| **Hubs** | resources | hub rail + pivot lens (`p`), never tree roots |

## 2. Surfaces

**Persistent chrome (always visible, above editor):**

- **Tab strip**: `overview · work · local · remote · fiddle` — fiddle's slot
  lights up only when a lane is selected; otherwise dimmed.
- **Hub rail**: one line per hub — workers USING it (compute/inference
  legs), running total, sparkline. Example:
  `ikea 3via·2loc ▁▂▅▂▁ · muramasa 2via·1loc ▁▁▂▁▁`

**Dock (toggleable right column overlay, ~40 cols):** the active tab's view.
Toggle via keybinding and `/dock` command. While open, the transcript area is
covered; `Esc` closes. (pi's layout cannot persistently split the transcript
area; overlay is the sanctioned mechanism — `ctx.ui.custom` with `HStack`.)

## 3. Views

### overview
Rollup of work + lanes: per-hub rail lines, local worker count, work
distribution snapshot (items by state, READY depth), watchdog verdict.
Everything glanceable, no interaction beyond tab switch.

### work
Local work distribution: items × lanes. Which items claimed, by whom (which
lane), what is READY vs blocked. Flat table, same column-grid machinery as the
tree (see §5).

### local (tree)
Workers bound to this session. Root = my session; children = workers; each
worker expands to its inference legs. Compute location is a column — a local
worker may run in azure and ride IKEA for inference.

```
  ◆ my-session              3 workers · 2 running ▁▂▅▂▁
  ├─ wasm-lint              ◆ running · loc muramasa · 12m
  │   ├─ via ikea/gpt-6.1-sol   leg 8m · 41 calls
  │   └─ via muramasa/glm-5.3   leg 4m · 9 calls
  ├─ azure-runner-3         ◆ running · loc azure/eastus · 2h
  │   └─ via ikea/gpt-6.1-sol   leg 2h · 310 calls
  └─ quick-clone            ◆ idle · loc docker-desktop · 40m
```

Select worker row → `Enter` → fiddle. Leg rows are read-only in v1
(re-routing a leg is future work).

### remote (tree, eza-style)
Navigable tree, ORIGIN as roots (controller, service, other owner — whoever
holds the worker's lifetime), workers as children, inference legs as leaves.
Hubs appear only as attributes (`loc:`, `via:`) — they are resources, not
containers. `/` filter prunes to matching workers (origin parents kept);
`p` pivots the same worker set by compute hub or inference hub — the hub
lens without hub-bound storage:

```
  ▣ fleet-controller          2 workers · 1 running ▁▂▁▁▁
  ├─ runner-mvp               ▣ running · loc docker-desktop · W2884 · 4m
  │   └─ via muramasa/glm-5.3     leg 4m · 12 calls
  └─ nas-burst                ▣ dark · loc nas · daytime-only
  ▣ ikea-service              3 workers · 2 running ▁▃▅▃▂
  ├─ glm-build-01             ▣ running · loc hub-box · W54 · 12m
  │   └─ via ikea/gpt-6.1-sol     leg 12m · 88 calls
  ├─ claude-lane-7            ▣ idle · loc azure/west · last W62 done 2h
  └─ copilot-w20              ▣ parked · loc hub-box · digest ok
```

Keys: `↑/↓` walk visible nodes · `→/l` expand · `←/h` collapse ·
`Enter` on worker → fiddle · `Enter` on origin → toggle · `/` filter ·
`p` pivot (origin → compute → inference) · `r` refresh.
Sticky cursor across expand/collapse/filter/pivot.

### fiddle (lane detail, stateful)
Opened by selecting a lane in local or remote; remembers the lane.

- **Header**: `▣ glm-build-01 · origin ikea-service · loc hub-box · via
  ikea/gpt-6.1-sol · owner: you · rights: steer,wake,park · running W54 ·
  ▁▃▅▃▂` (identity, class, origin, compute, inference, owner, rights, state,
  sparkline)
- **Recent activity**: last N events for the lane from the WS feed (status
  updates, digests, claims) — the "status updates / work" read.
- **Action menu, rights-filtered**: `steer` (type note → `coord message`,
  shows queued/accepted receipt) · `wake` · `park` · `ack` (pending events,
  per-item or all) · `restart` hint · `cancel` (red, confirm dialog).
- Plane refusals shown **verbatim**; destructive actions always confirm.
- `Esc` returns to the list the lane came from.

## 4. Data plane (no hand-rolled state)

**Federated by construction.** The local session CANNOT see into remote
compute (an azure VM, an on-prem box): it does not know those sessions exist,
let alone where they run. Each hub is AUTHORITATIVE for the sessions it
hosts; the cockpit merges per-hub answers and stamps every row with its
reporting hub. Unknown = `unreported`, never fabricated.

**Worker registration contract (executor → hub):** long-lived remote
drivers/executors announce on connect and on change — heartbeat keeps it
fresh: `{sid, name, description, purpose, compute: {kind, host, region},
started_at, activity}`. This is what lets a hub answer "I am running 4
long-lived remote sessions: 2 from this azure VM, 1 from this on-prem VM,
1 from this aws box." The microVM substrate (W2865 lineage) implements this
in its cloned-VM bootstrap; unregistered sessions are the hub's problem to
surface, not the cockpit's to invent.

- `coord fleet --json` — ambient aggregate feed (all lanes my plane knows).
  Already proven; powers hub rail + statusline today. Covers ONLY
  plane-visible lanes.
- **`coord workers --json`** — NEW verb (fleet work item): FEDERATED worker
  inventory — plane-visible lanes + per-hub self-reported sessions (from the
  registration contract above). Fields: `sid, name, class: local|remote,
  origin: {kind: session|controller|service|user, id} | unreported, compute:
  {kind: hub|cloud|local, host, region} | unreported, inference: [{hub,
  model, since, calls}], owner_sid, rights[], state, task, activity[],
  reported_by: <hub>`. `origin`, `compute`, `inference` are three INDEPENDENT
  pointers — no hub containment. Rights computed by the plane for the asking
  lane (owner / steerable / read-only); remote rows not visible to the local
  plane inherit rights from their reporting hub's answer. UI renders; plane
  enforces. (Hub-scoped alias `coord hub <name> workers --json` = that hub's
  authoritative answer only.)
- Hub list: `coord targets` / stack.json peers — same source as the W2878
  board dropdown.
- Sparklines: rolling event buckets from the fleet-receiver WS feed
  (per lane and per hub). Bucket width ~5 min, window ~2 h, braille blocks.
- Polling: statusline's proven two-phase pattern (fast phase every tick,
  lane phase in-flight-guarded).

Note: today's fleet JSON has no `class`/`owner_sid`/`rights` fields — lane
name prefixes like `[IKEA]` are hints, not contracts. The workers verb is the
contract; until it ships, the cockpit degrades to name-prefix inference and
renders inferred fields dimmed.

## 5. Rendering: columnar alignment (hard requirement)

Owner is a stickler for columnar alignment; NO hand-padded strings.

- Every table/tree row renders as a **column grid**:
  `gutter · name · state · task/item · age · sparkline`.
- Column widths computed per render from the widest **visible** cell in each
  column, ANSI-escape and widechar aware — via pi-tui's `visibleWidth()`.
- Overflow: cells truncate with ellipsis via `truncateToWidth()`; the name
  column gets a max-share cap so one long lane name cannot push others out.
- Sparkline column right-aligned at the dock's right edge.
- Widths recomputed on data change, expand/collapse, filter, resize.

## 6. Rights model

- Rights come from the plane (workers verb `rights[]`), computed per asking
  lane. Three tiers: **owner** (full fiddle), **steerable** (subset the plane
  allows), **read-only**.
- UI: action menu filtered by rights; refusals verbatim; no guessing.
- No-rights lanes: visible read-only by default; hide is a setting.

## 7. Non-goals (v1)

- No persistent split of the transcript area (pi layout constraint).
- No `work` tree (items → claims → lanes) — follow-up.
- No direct transcript reading of remote lanes — activity comes from the WS
  feed and plane state only.
- No tmux-level integration.

## 8. Implementation shape

- New pi extension `fleet-cockpit` in the fleet repo (same layout as
  fleet-statusline/fleet-awareness), installed to `~/.pi/agent/extensions/`.
- Shares the receiver WS feed with fleet-receiver via its event file/pipe —
  no second WS connection.
- Reuses fleet-statusline's two-phase polling and coord invocation helpers;
  statusline keeps ownership of the footer line and stays untouched
  (W2883 coordination: cockpit owns persistent chrome + dock; ChatGPT keeps
  /fleet panel-internal polish).

## 9. Fleet coordination items

1. Minted: **cockpit TUI extension** — W2887 (claimed by pi lane).
2. Minted: **`coord workers --json` verb + registration contract** — W2886
   (federated inventory; hubs authoritative for what they host).
3. Minted: **pi-durable registration + heartbeat patterns** — W2888 (joint
   with ChatGPT runner-durable line + fleet controller W2869/W2869.2):
   stable sid across host death with announce re-bind, announce location,
   runner.* event-stream integration, lease/fencing interplay, inference-leg
   recording, activity cursor.
4. ChatGPT messaged: W2883 re-scope — panel-internal polish only; persistent
   chrome + dock = cockpit item (this design).
5. W2878 board dropdown: hub list source stays `coord targets`/stack.json
   peers; cockpit consumes the same list — one source of truth.

## 10. Testing

- Column-grid unit tests: ANSI/widechar widths, truncation, recompute on
  state change (use pi-tui's exported width utils as ground truth).
- Tree unit tests: expand/collapse cursor stickiness, filter pruning.
- Rights-gate tests: menu filtering per rights tier; refusal rendering.
- Mocked plane fixtures (no live coord in CI); live smoke against muramasa
  hub in a tmux-driven pi session (proven witness harness).
- Receiver integration: sparkline buckets from recorded WS event fixtures.
