// hooks/board-html/tasks.ts — tasks table + kanban + drawer (W157 client chunk), assembly face.
// W2269.1.3 decompose: view state (tasks-view.ts), executor catalog (tasks-executors.ts),
// item lifecycle POSTs (tasks-actions.ts), spend-series garnish (tasks-spend.ts); this file
// keeps the render face — table rows, backtick-free kanban columns/cards (W2267.4.x scope, patch-only), drawer.
import { TASKS_ACTIONS } from "./tasks-actions.ts";
import { TASKS_OWNER } from "./tasks-owner.ts";
import { TASKS_EXECUTORS } from "./tasks-executors.ts";
import { TASKS_SPEND } from "./tasks-spend.ts";
import { TASKS_VIEW } from "./tasks-view.ts";
import { embedDualShort, embedDualStamp } from "../lib/wallclock.ts";
import { executionSummary } from "../lib/work/work-execution.ts";

export const TASKS =
	TASKS_VIEW +
	TASKS_OWNER +
	TASKS_EXECUTORS +
	TASKS_ACTIONS +
	TASKS_SPEND +
	String.raw`var executionSummary = ${executionSummary.toString()};
// --- 4: tasks table (Tasks tab, /api/tasks) + drawer (/api/task) ---
// W902: shared stamp vocabulary, inlined for this chunk scope
var dualStamp = ${embedDualStamp.toString()};
var dualShort = ${embedDualShort.toString()};
function pollTasks(){ feeds.kick('tasks', true); }
// W518: the .prefer tag + color ride every board row (W517's lib resolves
// the repo tree's .prefer; taskShape emits t.tag + t.tag_color — the stamped
// tag wins, color is always the live tree color). Absent color = no
// affordance. The color feeds the --prefer token: kanban card border + a
// small list dot; the tag names the title tooltip.
function preferOf(t){
  var c = t && t.tag_color ? String(t.tag_color) : '';
  if (!c) return null;
  return { tag: (t && t.tag ? String(t.tag) : ''), color: c };
}
function preferStyle(t){
  var p = preferOf(t);
  return p ? ' style="--prefer:' + esc(p.color) + '"' : '';
}
// W776 — per-item attribution (spend.fresh/cached/out, spend.wall_ms) rendered
// compact; '-' when the item has no attribution at all.
function spendTotal(t){
  var sp = t && t.spend ? t.spend : null;
  return sp ? (sp.fresh + sp.cached + sp.out) : 0;
}
function fmtTokShort(n){
  if (!n) return '-';
  if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M';
  if (n >= 1e3) return Math.round(n / 1e3) + 'k';
  return String(n);
}
function fmtWall(ms){
  if (!ms) return '-';
  var m = Math.round(ms / 60000);
  if (m >= 60) return Math.floor(m / 60) + 'h' + String(m % 60).padStart(2, '0') + 'm';
  return m + 'm';
}
function spendCell(t){
  return fmtTokShort(spendTotal(t));
}
function wallCell(t){
  return fmtWall(t && t.spend ? t.spend.wall_ms : 0);
}
// W887 micro-strip text half: wall · tok/min · cache-hit % (the sparkline
// half is painted as SVG by paintSparks; these helpers own the numbers).
function tokPerMin(sp){
  var m = sp && sp.wall_ms ? sp.wall_ms / 60000 : 0;
  return m > 0 ? sp.out / m : null;
}
function cachePct(sp){
  var denom = sp ? sp.fresh + sp.cached : 0;
  return denom > 0 ? (sp.cached / denom) * 100 : null;
}
function fmtRate(n){
  if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M';
  if (n >= 1e3) return (n / 1e3).toFixed(1) + 'k';
  return String(Math.round(n));
}
function spendStripText(sp){
  var rpm = tokPerMin(sp), cp = cachePct(sp);
  var s = fmtWall(sp.wall_ms);
  if (rpm != null) s += ' · ' + fmtRate(rpm) + ' tok/m';
  if (cp != null) s += ' · ' + Math.round(cp) + '% cache';
  if (sp.cost_usd != null) s += ' · $' + sp.cost_usd.toFixed(sp.cost_usd < 0.01 ? 4 : 2);
  return s;
}
// W998.3 — ONE builder for the kspendtxt strip text, shared by the render
// path and the volatile refresh so the two cannot drift (stampFull idiom).
function spendStripInner(sp){
  return fmtTokShort(sp.fresh + sp.cached + sp.out) + ' tok · ' + spendStripText(sp);
}
function spendStripHtml(t, cls){
  var sp = t && t.spend ? t.spend : null;
  var key = esc(String(t.project || '')) + '|' + esc(String(t.id));
  // no attributed spend = no spend strip (the pre-W970 guard, lost in the port)
  var spendPart = sp ? '<div class="kspend' + (cls ? ' ' + cls : '') + ' dim"><div class="ksparkplot"><span class="kspark" data-spark="' + key + '"></span><div class="ksparkaxis"><span>first request</span><span>latest</span></div></div><span class="kspendtxt" title="Attributed totals for this work item">' + esc(spendStripInner(sp)) + '</span></div>' : '';
  var attemptPart = '';
  if (attemptView) attemptPart = '<div class="kattemptwrap dim"><span class="kattemptlabel">current attempt · fixed 90 min · 3 min/bin</span><span class="kattempt" data-attempt="' + key + '"></span></div>';
  return spendPart + attemptPart;
}
function displayState(t){
  if ((t.state === 'CLAIMED' || t.state === 'RUNNING') && t.execution && t.execution.state === 'paused') return 'PAUSED';
  return t.state === 'READY' && t.blocked_by && t.blocked_by.length ? 'BLOCKED' : t.state;
}
function laneStamp(s){
  if (!s) return '';
  var d = new Date(s); if (isNaN(d.getTime())) return esc(s);
  return '<time datetime="' + esc(d.toISOString()) + '" title="' + esc(dualStamp(d)) + '">' + esc(dualShort(d)) + '</time>';
}
// W998 — card dates compact to a relative update age; the full instant stays
// on hover (same <time> contract as laneStamp). msAgo/agoShort ride the CORE
// chunk globals at board runtime.
// W998.3 — stampFull is the ONE tooltip builder, shared by the render path
// (compactStamp) and the in-place volatile refresh (updateKanbanVolatile) so
// the two cannot drift.
function stampFull(d){
  return 'updated ' + d.toLocaleString('da-DK', {dateStyle:'full', timeStyle:'long'}) + ' · UTC ' + d.toISOString();
}
function compactStamp(s){
  if (!s) return '';
  var d = new Date(s); if (isNaN(d.getTime())) return esc(s);
  return '<time datetime="' + esc(d.toISOString()) + '" title="' + esc(stampFull(d)) + '">' + esc(agoShort(msAgo(d.getTime()))) + '</time>';
}
function taskRow(t, parentId, depth){
  var owner = ownerName(t);
  var prefer = preferOf(t);
  var pdot = prefer ? '<span class="pdot" style="--prefer:' + esc(prefer.color) + '" title="prefer: ' + esc(prefer.tag || prefer.color) + '"></span>' : '';
  var od = t.open_decisions || 0;
  var kid = parentId ? '<span class="kidmark">↳</span>' : '';
  var ub = (displayState(t) === 'READY' && t.unblocked_by) ? '<span class="dim" title="unblocked by ' + esc(t.unblocked_by) + ' — startable">▶ </span>' : '';
  return '<tr class="' + (parentId ? 'taskkid' : '') + '"' + (parentId ? ' style="--indent:' + (Math.min(Number(depth) || 1, 4) * 12) + 'px"' : '') + ' data-tid="' + esc(t.id) + '"><td>' + pdot + kid + ub + '<button type="button" class="tidbtn mono" data-task="' + esc(t.id) + '" data-proj="' + esc(t.project || '') + '" aria-haspopup="dialog"' + (parentId ? ' aria-label="' + esc(t.id) + ', child of ' + esc(parentId) + '"' : '') + '>' + esc(t.id) + '</button></td>' +
    '<td class="mono dim">' + esc(projShort(t.project)) + '</td>' +
    '<td class="ttitle">' + esc(String(t.title || '(untitled)')).slice(0, 120) +
      (t.tail && t.tail.text ? '<div class="tail dim">' + esc(t.tail.text) + '</div>' : '') +
      (t.signal ? '<div class="tail dim">⚑ ' + esc(t.signal.class) + ' · ' + Math.round((t.signal.confidence || 0) * 100) + '%</div>' : '') + '</td>' +
    '<td>' + taskPill(displayState(t)) + '</td>' +
    '<td class="taskowner" title="' + esc(String(t.owner_sid || owner)) + '">' + esc(owner) + '</td>' +
    '<td class="num"' + (t.spend ? ' title="' + esc(spendStripText(t.spend)) + '"' : '') + '>' + esc(spendCell(t)) + '</td>' +
    '<td class="num">' + esc(wallCell(t)) + '</td>' +
    '<td class="num">' + agoShort(t.age_s) + '<div class="dim kwhen">' + laneStamp(t.updated_at_utc) + '</div></td>' +
    '<td class="num' + (od ? ' rq' : '') + '">' + (od || '-') + '</td></tr>';
}
function taskTreeHtml(pool){
  var g = taskGroups(pool);
  sortTasks(g.roots);
  var html = '';
  function addTree(t, parentId, depth){
    html += taskRow(t, parentId, depth);
    var kids = g.kids[taskGroupKey(t)];
    if (kids) { sortTasks(kids); for (var c = 0; c < kids.length; c++) addTree(kids[c], t.id, depth + 1); }
  }
  for (var i = 0; i < g.roots.length; i++) addTree(g.roots[i], null, 0);
  return html;
}
function renderTasks(){
  var errEl = byId('tasksErr');
  var body = byId('tasksBody');
  if (!tasksLoaded && !tasksErr) {
    errEl.text = '';
    sigSet(body, 'loading', '<tr><td colspan="9" class="dim">loading tasks...</td></tr>');
    return;
  }
  if (tasksErr) {
    var when = tasksOkAt ? ago(Math.round((Date.now() - tasksOkAt) / 1000)) : 'never';
    errEl.text = 'task list unavailable — last good ' + when;
  } else {
    errEl.text = '';
  }
  if (!tasksData) return; // nothing good yet — keep loading/error row
  var taskSection = byId('tab-tasks');
  if (taskSection) taskSection.classList.toggle('taskcompact', !taskExpanded);
  var detailsButton = byId('taskDetails');
  if (detailsButton) detailsButton.setAttribute('aria-pressed', taskExpanded ? 'true' : 'false');
  var ts = tasksData.tasks;
  buildOwnerDisp(ts);
  renderTaskOwnerOptions(ts);
  var own = taskOwner === 'all' ? ts : ts.filter(function(t){ return ownerKey(t) === taskOwner; });
  // #filter= deep-link narrows rows to an id/owner/session substring (case-insensitive)
  if (hashFilter) own = own.filter(function(t){ return hashMatch([t.id, t.title, ownerKey(t), ownerName(t), t.project]); });
  if (boardQuery) own = own.filter(function(t){ return boardMatch([t.id, t.title, t.state, ownerKey(t), ownerName(t), t.project]); });
  // completed items are opt-in (a healthy fleet buries live work under DONE rows)
  var showDone = false;
  try { showDone = localStorage.getItem('taskShowDone') === '1'; } catch(e) {}
  var cb = byId('taskDone'); if (cb) cb.checked = showDone;
  var open = own.filter(function(t){ return t.state !== 'DONE' && t.state !== 'CANCELLED'; });
  var counts = {all: open.length, attention: 0, working: 0, paused: 0, ready: 0, waiting: 0};
  for (var i = 0; i < open.length; i++) counts[taskBucket(open[i])]++;
  var focus = byId('taskFocus');
  if (focus) {
    var allLabel = focus.querySelector('[data-focus="all"]');
    if (allLabel && allLabel.firstChild) allLabel.firstChild.textContent = showDone ? 'All tasks ' : 'All open ';
    if (showDone) counts.all = own.length;
    var buttons = focus.querySelectorAll('[data-focus]');
    for (var j = 0; j < buttons.length; j++) {
      var key = buttons[j].getAttribute('data-focus');
      buttons[j].setAttribute('aria-pressed', key === taskFocus ? 'true' : 'false');
      var count = buttons[j].querySelector('[data-count]');
      if (count) count.textContent = counts[key];
    }
  }
  var pool = showDone && taskFocus === 'all' ? own : open;
  if (taskFocus !== 'all') pool = pool.filter(function(t){ return taskBucket(t) === taskFocus; });
  var html = taskTreeHtml(pool);
  if (!html) html = '<tr><td colspan="7" class="dim">' + (ts.length ? '(no tasks match the filters)' : '(no tasks)') + '</td></tr>';
  var cnt = byId('taskCount');
  if (cnt) {
    cnt.textContent = pool.length === ts.length ? pool.length + ' tasks' : pool.length + ' of ' + ts.length + ' tasks';
    var cred = 0;
    for (var ci = 0; ci < pool.length; ci++) if (needsCred(pool[ci].requires)) cred++;
    if (cred) cnt.textContent += ' · ' + cred + ' credentialed';
  }
  var page = document.scrollingElement || document.documentElement;
  var pageY = page.scrollTop;
  sigSetKeep(body, html, html, 'data-task'); // rebuild only on real change; refocus the row button if the table swapped under it
  page.scrollTop = pageY;
}
// --- W65 lanes kanban: work items as cards in state columns; active cards
// carry the owner lane's live transcript tail (1s poll). A card click expands
// straight into the task drawer (diff + comments); unclaimed READY cards get
// a start button that POSTs /api/start (fleet-loop dispatch).
var KCOLS = [
  { key: 'READY', label: 'ready', states: ['READY'] },
  { key: 'WAITING', label: 'waiting', states: ['WAITING', 'SHATTERED'], cap: 12 },
  { key: 'ACTIVE', label: 'claimed', states: ['CLAIMED', 'RUNNING'] },
  { key: 'PAUSED', label: 'paused', states: ['PAUSED'], hideEmpty: true },
  { key: 'BLOCKED', label: 'blocked', states: ['BLOCKED'], hideEmpty: true },
  { key: 'FAILED', label: 'failed', states: ['FAILED'], hideEmpty: true },
  { key: 'DONE', label: 'done', states: ['DONE'], cap: 12 },
  { key: 'CANCELLED', label: 'cancelled', states: ['CANCELLED'], cap: 12 }
];
function ensureKstatusNav(){
  var nav = byId('kstatusnav');
  if (!nav) return;
  var tog = byId('attemptView');
  if (tog) tog.setAttribute('aria-pressed', attemptView ? 'true' : 'false');
  if (nav.querySelector('button[data-kcol]')) return;
  for (var i = 0; i < KCOLS.length; i++) {
    var button = document.createElement('button');
    button.type = 'button';
    button.setAttribute('data-kcol', String(i));
    button.setAttribute('data-tone', workTone(KCOLS[i].states[0]));
    button.textContent = KCOLS[i].label;
    nav.appendChild(button);
  }
  nav.addEventListener('click', function(e){
    var tog = e.target.closest && e.target.closest('#attemptView');
    if (tog) { toggleAttemptView(); return; }
    var button = e.target.closest && e.target.closest('button[data-kcol]');
    if (!button) return;
    var key = KCOLS[Number(button.getAttribute('data-kcol'))].key;
    var col = byId('kanban').querySelector('.kcol[data-kcol-key="' + key + '"]');
    var wrap = byId('kanban').parentElement;
    if (!col || !wrap) return;
    wrap.scrollTo({ left: wrap.scrollLeft + col.getBoundingClientRect().left - wrap.getBoundingClientRect().left, behavior: 'smooth' });
  });
}
function toggleAttemptView(){
  attemptView = !attemptView;
  try { localStorage.setItem('sb.attemptView', attemptView ? '1' : '0'); } catch (e) {}
  var tog = byId('attemptView');
  if (tog) tog.setAttribute('aria-pressed', attemptView ? 'true' : 'false');
  renderKanban();
}
// W998.3.1 — ONE builder for the execution klane's observed tooltip, shared
// by the render path (kanbanCard) and the in-place volatile refresh
// (updateKanbanVolatile) so the two cannot drift (stampFull idiom).
function klaneObservedTitle(ex){
  return esc(ex.source + ' · observed ' + new Date(ex.observed_at).toISOString());
}
function kanbanCard(t, fam){
  var od = t.open_decisions || 0;
  var tone = workTone(displayState(t));
  var startable = displayState(t) === 'READY' && !t.owner_sid;
  var active = (t.state === 'CLAIMED' || t.state === 'RUNNING') && t.owner_sid;
  var kid = fam && fam.nested[String(t.id)];
  var kidStyle = '';
  if (kid) {
    if (kid.c) kidStyle += '--prefer:' + esc(kid.c) + ';';
    kidStyle += 'margin-left:' + (Math.min(kid.d, 2) * 14) + 'px';
  }
  var html = '<div class="kcard' + (kid ? ' kkid' : '') + '"' + (kid ? ' style="' + kidStyle + '"' : preferStyle(t)) + ' data-tone="' + tone + '" data-kid="' + esc(t.id) + '" data-kproj="' + esc(t.project || '') + '" title="open details">';
  if (kid) html += '<span class="kidmark">↳</span>';
  html += '<div class="krow">' + taskPill(displayState(t)) +
    (od ? '<span class="kdec">needs you</span>' : '') +
    (t.requires ? '<span class="kdec mono" title="credential requires: ' + esc(String(t.requires)) + '">needs ' + esc(String(t.requires)) + '</span>' : '') +
    (t.updated_at_utc ? '<span class="kcardstamp dim">' + compactStamp(t.updated_at_utc) + '</span>' : '') + '</div>' +
    '<div class="kcardident"><button type="button" class="tidbtn mono" data-task="' + esc(t.id) + '" data-proj="' + esc(t.project || '') + '" aria-haspopup="dialog">' + esc(t.id) + '</button>' +
    '<span class="kage dim" title="open ' + esc(ago(t.age_s)) + '">' + esc(agoShort(t.age_s)) + '</span></div>';
  html += '<div class="ktitle">' + esc(String(t.title || '(untitled)')).slice(0, 140) + '</div>';
  if (t.execution) {
    var ex = t.execution;
    var proof = ex.progress ? ex.progress.stage + ' · ' + new Date(ex.progress.ts).toISOString() : 'no artifact evidence in snapshot';
    html += '<div class="klane dim" title="' + klaneObservedTitle(ex) + '">' + esc(ex.state + ' · ' + proof) + '</div>';
  }
  if (displayState(t) === 'BLOCKED' && t.blocked_by && t.blocked_by.length)
    html += '<div class="klane dim">waiting on ' + esc(t.blocked_by.join(', ')) + '</div>';
  if (t.state === 'SHATTERED' && t.waiting_on && t.waiting_on.length)
    html += '<div class="klane dim">split into ' + esc(t.waiting_on.join(', ')) + '</div>';
  if (t.state === 'WAITING' && t.wait_reason)
    html += '<div class="klane dim" title="' + esc(t.wait_reason) + '">' + esc(t.wait_kind || 'external') + ' · ' + esc(t.wait_reason) + '</div>';
  var laneOwner = String(t.owner_label || t.owner_sid || 'unclaimed');
  var laneOrigin = t.origin ? String(t.origin) : '';
  html += '<div class="kmeta">';
  if (t.model) html += '<span class="kmodel" title="model: ' + esc(String(t.model)) + (t.locality ? ' · ' + esc(String(t.locality)) : '') + '">' + esc(String(t.model)) + '</span>';
  html += '<span class="klane dim" title="lane ' + esc(laneOwner) + (laneOrigin ? ' · ' + esc(laneOrigin) : '') + '">' + (laneOrigin ? 'via ' + esc(laneOrigin) : 'lane ' + esc(laneOwner)) + '</span></div>';
  html += spendStripHtml(t);
  if (t.state === 'FAILED' && t.failure_note) html += '<div class="kfailure" title="Open details for the full failure reason">' + esc(String(t.failure_note).split(';')[0]) + '</div>';
  if (t.tail && t.tail.text) html += '<div class="ktail">' + esc(t.tail.text) + '</div>';
  if (t.state === 'FAILED') html += '<div class="kexec"><button type="button" class="kstart" data-retry="' + esc(t.id) + '" data-retryproj="' + esc(t.project || '') + '" title="requeue — FAILED to READY; operator-gated items need a force confirm">↺ retry</button></div>';
  if (t.signal) html += '<div class="ksignal dim">⚑ ' + esc(t.signal.class) + ' · ' + Math.round((t.signal.confidence || 0) * 100) + '%</div>';
  if (t.report) html += '<a class="kreport dim" href="/api/report/' + encodeURIComponent(t.id) + '?project=' + encodeURIComponent(t.project || '') + '" target="_blank" rel="noopener" title="single-file HTML report — a generated view of the item\'s markdown record">report ▸</a>';
  if (startable) {
    var pick = defaultPick(t);
    var opts = execOptions(pick);
    var pickedOpt = execOpts.filter(function(o){ return o.value === pick; })[0];
    var effOpts = '';
    for (var ei = 0; ei < EFFORT_LEVELS.length; ei++)
      effOpts += '<option value="' + EFFORT_LEVELS[ei] + '">' + EFFORT_LEVELS[ei] + '</option>';
    var effortSel = (pickedOpt && pickedOpt.reasoningEffort)
      ? '<select class="keffortsel" aria-label="reasoning effort for ' + esc(t.id) + '"><option value="">effort</option>' + effOpts + '</select>'
      : '';
    html += '<div class="kexec"><select class="kexecsel" aria-label="executor for ' + esc(t.id) + '">' + opts + '</select>' +
      effortSel +
      '<button type="button" class="kstart" data-start="' + esc(t.id) + '" data-startproj="' + esc(t.project || '') + '" title="dispatch on the chosen executor">▶</button></div>';
  }
  if (active) {
    var pick2 = defaultPick(t);
    html += '<div class="kexec"><select class="kexecsel" aria-label="reassign executor for ' + esc(t.id) + '">' + execOptions(pick2) + '</select>' +
      '<button type="button" class="kstart" data-reassign="' + esc(t.id) + '" data-reassignproj="' + esc(t.project || '') + '" title="release + re-dispatch on the chosen executor (capsule is the handoff)">↻</button>' +
      '<button type="button" class="kstart" data-unclaim="' + esc(t.id) + '" data-unclaimproj="' + esc(t.project || '') + '" title="release the claim — a live lane is asked to bank its capsule and exit">⏏</button></div>';
  }
  html += '<button type="button" class="korch" data-orch="' + esc(t.id) + '" data-orchproj="' + esc(t.project || '') + '" aria-label="Orchestrate for ' + esc(t.id) + '">prompt ↗</button>';
  return html + '</div>';
}
// Keep in-column dependencies in provider-first order. The cards state
// blocked_by and waiting_on explicitly; cross-column connector lines obscure
// which work is related when the source card is outside the viewport.
var tkey = function(t){ return (t.project || '') + '\u0000' + t.id; };
function depOrder(items){
  var byId = {}, indeg = {}, outs = {}, i, d;
  for (i = 0; i < items.length; i++) byId[tkey(items[i])] = items[i];
  for (i = 0; i < items.length; i++){ indeg[tkey(items[i])] = 0; outs[tkey(items[i])] = []; }
  var edge = function(a, b){
    if (byId[a] && byId[b] && a !== b){ outs[a].push(b); indeg[b]++; }
  };
  for (i = 0; i < items.length; i++){
    var t = items[i];
    var bb = t.blocked_by || [];
    for (d = 0; d < bb.length; d++) edge(tkey({project: t.project, id: bb[d]}), tkey(t));
    var wo = t.waiting_on || [];
    for (d = 0; d < wo.length; d++) edge(tkey({project: t.project, id: wo[d]}), tkey(t));
  }
  var order = [], q = [];
  for (i = 0; i < items.length; i++) if (!indeg[tkey(items[i])]) q.push(tkey(items[i]));
  while (q.length){
    var id = q.shift(); order.push(id);
    var o = outs[id];
    if (o) for (var k = 0; k < o.length; k++) if (--indeg[o[k]] === 0) q.push(o[k]);
  }
  // cycle fallback: unprocessed nodes keep the incoming (age) order
  if (order.length < items.length){
    for (i = 0; i < items.length; i++) if (indeg[tkey(items[i])] > 0) order.push(tkey(items[i]));
  }
  var pos = {};
  for (i = 0; i < order.length; i++) pos[order[i]] = i;
  return items.slice().sort(function(a, b){ return pos[tkey(a)] - pos[tkey(b)]; });
}
// W819 — shattered-family grouping: non-terminal children of a SHATTERED
// parent render directly beneath the parent card (dashed border in the
// parent's --prefer color) instead of as scattered state-column siblings.
// Terminal children (DONE/CANCELLED) stay in their state columns; a child
// whose parent is absent from the pool stays put. kanbanFamIndex() finds the
// anchors (SHATTERED items whose parent is absent or not SHATTERED — the
// WAITING residents family subtrees hang from).
function kanbanFamIndex(pool){
  var byId = {}, anch = {}, i, id;
  for (i = 0; i < pool.length; i++) byId[String(pool[i].id)] = pool[i];
  for (id in byId){
    var s = byId[id];
    if (s.state !== 'SHATTERED') continue;
    var dot = id.lastIndexOf('.'), pid = dot > 0 ? id.slice(0, dot) : null;
    var par = pid ? byId[pid] : null;
    if (!par || par.state !== 'SHATTERED') anch[id] = s;
  }
  return {byId: byId, anch: anch};
}
// kanbanFamilies() resolves the nested-shattered-family layout: nested maps
// childId → {a: anchorId, d: depth, c: color} (the nearest SHATTERED
// ancestor carries the color); under maps anchorId → depth-first subtree.
function kanbanFamilies(pool){
  var idx = kanbanFamIndex(pool), byId = idx.byId, anch = idx.anch;
  var nested = {}, kidsOf = {};
  function resolve(t){
    if (displayState(t) === 'PAUSED') return null;
    if (t.state === 'DONE' || t.state === 'CANCELLED') return null;
    var id2 = String(t.id), dot = id2.lastIndexOf('.'), pid = dot > 0 ? id2.slice(0, dot) : null;
    if (!pid) return null;
    var par = byId[pid];
    if (!par) return null;
    if (anch[pid]) return {a: pid, d: 1};
    var up = resolve(par);
    return up ? {a: up.a, d: up.d + 1} : null;
  }
  var id;
  for (id in byId){
    var x = byId[id], n = resolve(x);
    if (!n) continue;
    n.c = byId[n.a].tag_color ? String(byId[n.a].tag_color) : '';
    nested[id] = n;
    var kdot = id.lastIndexOf('.'), kpid = kdot > 0 ? id.slice(0, kdot) : null;
    (kidsOf[kpid] || (kidsOf[kpid] = [])).push(x);
  }
  // depth-first subtree render order per anchor: kids by age, grandchildren
  // following their parent
  var under = {};
  function walk(pid, out){
    var ks = (kidsOf[pid] || []).slice().sort(function(x, y){ return (x.age_s || 0) - (y.age_s || 0); });
    for (var k = 0; k < ks.length; k++){
      out.push(ks[k]);
      walk(String(ks[k].id), out);
    }
  }
  for (var a in anch){
    var out = [];
    walk(a, out);
    if (out.length) under[a] = out;
  }
  return {nested: nested, under: under};
}
// W998.3 — the kanban structural signature: card html with every volatile
// age/stamp element reduced to its shell (attributes tolerated — W998 put a
// tooltip on the kage span and a <time datetime title> inside kcardstamp).
// The kage/kcardstamp/ktail SHELLS stay, so a card gaining or losing a stamp
// or tail div still counts as structural; only per-second content churn is
// excluded. Beyond the card markup, three per-poll observation instants ride
// the page and would churn the signature every second: the summary's checked
// suffix, the execution klane's observed tooltip and the spend strip's live
// wall age (rate + cache % stay structural — they are real spend facts).
// W998.3.1 — the observed normalization is scoped to the execution klane's
// title ATTRIBUTE and strips only the ISO instant tail: arbitrary card text
// or attribute content ("· observed <anything>") stays structural, so a
// rename is never hidden behind an identical signature (the W998.3 global
// '· observed' regex gave two different titles one signature and the stale
// card never rebuilt).
// One function so tests eval the shipped bytes.
function kanbanStructural(html){
  return html
    .replace(/<span class="kage dim"[^>]*>[^<]*<\/span>/g, '<span class="kage dim"></span>')
    .replace(/<span class="kcardstamp dim">(<time[^>]*>[^<]*<\/time>|[^<]*)?<\/span>/g, '<span class="kcardstamp dim"></span>')
    .replace(/<div class="ktail"[^>]*>[^<]*<\/div>/g, '<div class="ktail"></div>')
    // per-poll observation instants: the summary's checked suffix, the
    // execution klane's observed tooltip, the spend strip's live wall age
    .replace(/(<p class="dim" title="Harness presence is not productive output">[^<]*) · checked [^<]*/g, '$1 · checked')
    .replace(/(<div class="klane dim" title="[^"]* · observed )\d{4}-\d{2}-\d{2}T[^"]*/g, '$1')
    .replace(/(<span class="kspendtxt"[^>]*>[^<]*? tok · )([^<·]+?)( · [^<]*)?<\/span>/g, '$1$3</span>');
}
function renderKanban(){
  if (curTab !== 'lanes') return;
  var el = byId('kanban');
  if (!el) return;
  if (!tasksLoaded && !tasksErr) { sigSet(el, 'loading', '<div class="state dim">loading lanes...</div>'); return; }
  if (tasksErr) {
    byId('kanbanErr').text = ('lane board unavailable' + (tasksOkAt ? ' — last good ' + ago(Math.round((Date.now() - tasksOkAt) / 1000)) : ''));
    if (!tasksData) return; // nothing good yet — banner instead of stale cards
  } else {
    byId('kanbanErr').text = '';
  }
  if (!tasksData) return;
  var ts = tasksData.tasks;
  ensureKstatusNav();
  buildOwnerDisp(ts);
  if (hashFilter) ts = ts.filter(function(t){ return hashMatch([t.id, t.title, ownerKey(t), ownerName(t), t.project]); });
  if (boardQuery) ts = ts.filter(function(t){ return boardMatch([t.id, t.title, t.state, ownerKey(t), ownerName(t), t.project]); });
  var executionCounts = executionSummary(ts.filter(function(t){ return !!t.execution; }));
  var observed = ts.find(function(t){ return !!t.execution; });
  var summary = executionCounts.claims + ' claims · ' + executionCounts.owners + ' owners · ' + executionCounts.live_harnesses + ' live harnesses · ' + executionCounts.paused + ' paused · ' + executionCounts.blocked + ' blocked · ' + executionCounts.dead + ' dead · ' + executionCounts.unknown + ' unknown · ' + executionCounts.transitioning + ' transitioning';
  var html = '<p class="dim" title="Harness presence is not productive output">' + esc(summary) + (observed ? ' · checked ' + esc(new Date(observed.execution.observed_at).toISOString()) : ' · execution evidence unavailable') + '</p><div class="kanban">';
  var shownAll = [];
  var fam = kanbanFamilies(ts);
  for (var c = 0; c < KCOLS.length; c++) {
    var col = KCOLS[c];
    var items = ts.filter(function(t){ return col.states.indexOf(displayState(t)) >= 0; });
    items.sort(function(a, b){ return (a.age_s || 0) - (b.age_s || 0); }); // newest activity first
    items = depOrder(items); // provider above dependent when both are in a column
    var resid = [];
    for (var r = 0; r < items.length; r++) if (!fam.nested[String(items[r].id)]) resid.push(items[r]);
    var shown = col.cap ? resid.slice(0, col.cap) : resid;
    var jump = byId('kstatusnav').querySelectorAll('button[data-kcol]')[c];
    var visible = !col.hideEmpty || resid.length > 0;
    if (jump) { jump.textContent = col.label + ' ' + resid.length; jump.hidden = !visible; }
    if (!visible) continue;
    html += '<div class="kcol" data-kcol-key="' + col.key + '" data-tone="' + workTone(col.states[0]) + '"><h3>' + esc(col.label) + '<span class="kcount">' + resid.length + '</span></h3>';
    for (var i = 0; i < shown.length; i++){
      shownAll.push(shown[i]);
      html += kanbanCard(shown[i], fam);
      var sub = fam.under[String(shown[i].id)];
      if (sub) for (var k = 0; k < sub.length; k++){ shownAll.push(sub[k]); html += kanbanCard(sub[k], fam); }
    }
    if (!resid.length) html += '<div class="kempty dim">(empty)</div>';
    else if (col.cap && resid.length > col.cap) html += '<div class="kempty dim">+' + (resid.length - col.cap) + ' older — the table has all</div>';
    html += '</div>';
  }
  html += '</div>';
  // W104: the card html embeds per-second data (age ticks, live tails) — a
  // full sigSet at 1Hz destroys an open executor dropdown mid-pick. Rebuild
  // only when the STRUCTURE changed; refresh ages + tails in place otherwise.
  var kstruct = kanbanStructural(html);
  var prevStructural = el.getAttribute('data-ksig') || '';
  if (prevStructural === kstruct) { updateKanbanVolatile(el, shownAll); paintSparks(el); return; }
  if (el.contains(document.activeElement) && document.activeElement.classList && (document.activeElement.classList.contains('kexecsel') || document.activeElement.classList.contains('keffortsel'))) return; // picking — defer the swap, next render applies it
  var page = document.scrollingElement || document.documentElement;
  var pageY = page.scrollTop, laneX = el.parentElement.scrollLeft;
  el.setAttribute('data-ksig', kstruct);
  sigSet(el, kstruct, html);
  page.scrollTop = pageY;
  el.parentElement.scrollLeft = laneX;
  updateKanbanVolatile(el, shownAll);
  paintSparks(el);
  trySelectCard(); // W890 ?w= deep link: highlight+scroll once the kanban renders the card
}
function updateKanbanVolatile(el, shownAll){
  var cards = el.querySelectorAll('.kcard');
  for (var i = 0; i < shownAll.length && i < cards.length; i++) {
    var t = shownAll[i], c = cards[i];
    if (c.getAttribute('data-kid') !== t.id) continue;
    var ageEl = c.querySelector('.kage');
    if (ageEl) {
      ageEl.textContent = agoShort(t.age_s);
      ageEl.setAttribute('title', 'open ' + ago(t.age_s));
    }
    var stampEl = c.querySelector('.kcardstamp time');
    if (stampEl && t.updated_at_utc) {
      var sd = new Date(t.updated_at_utc);
      if (!isNaN(sd.getTime())) {
        stampEl.setAttribute('datetime', sd.toISOString());
        stampEl.setAttribute('title', stampFull(sd));
        stampEl.textContent = agoShort(msAgo(sd.getTime()));
      }
    }
    var tailEl = c.querySelector('.ktail');
    if (tailEl) tailEl.textContent = (t.tail && t.tail.text) ? t.tail.text : '';
    var klaneEl = c.querySelector('.klane');
    if (klaneEl && t.execution) klaneEl.setAttribute('title', klaneObservedTitle(t.execution));
    var spendEl = c.querySelector('.kspendtxt');
    if (spendEl && t.spend) {
      spendEl.textContent = spendStripInner(t.spend);
      spendEl.setAttribute('title', 'Attributed totals for this work item');
    }
    var sigEl = c.querySelector('.ksignal');
    if (sigEl) sigEl.textContent = t.signal ? '⚑ ' + t.signal.class + ' · ' + Math.round((t.signal.confidence || 0) * 100) + '%' : '';
  }
}
function openTask(id, proj, trigger){
  if (trigger) {
    var taskHash = '#task=' + encodeURIComponent(id) + (proj ? '&proj=' + encodeURIComponent(proj) : '');
    if (location.hash !== taskHash) history.pushState(null, '', location.pathname + location.search + taskHash);
  }
  task.id = id; task.proj = proj || null; task.data = null; task.err = null; task.okAt = 0; task.trigger = trigger || null;
  task.execution = null; task.executionBusy = false; task.executionAt = 0; task.executionErr = null;
  byId('drawer').hidden = false;
  setText(byId('drawerTitle'), 'task ' + id);
  sigSet(byId('drawerBody'), '', '<div class="state dim">loading task...</div>');
  resetDiff();
  resetTail();
  resetLaunch();
  pollTask(true);
  pollSpendSeries(true); // drawer sparkline wants the series now
  byId('drawerClose').focus();
}
function closeTask(keepHash){
  byId('drawer').hidden = true;
  if (keepHash !== true && location.hash.indexOf('#task=') === 0) history.replaceState(null, '', location.pathname + location.search + '#' + curTab);
  var t = task.trigger;
  var id = task.id;
  task.id = null; task.trigger = null; task.data = null;
  task.execution = null;
  if (t && document.contains(t)) { t.focus(); return; }
  var b = id ? document.querySelector('#tasksBody [data-task="' + id + '"]') : null;
  if (b) b.focus(); // row was re-rendered while open — refocus its button
}
function pollTask(force){ feeds.kick('task', !!force); }
function pollExecutionTrace(){ feeds.kick('exec', !task.execution && !task.executionErr); task.executionBusy = feeds.get('exec').busy; }
function renderDrawer(){
  if (!task.id) return;
  var d = task.data;
  setText(byId('drawerTitle'), d ? d.task.id + ' — ' + String(d.task.title || '').slice(0, 70) : 'task ' + task.id);
  var body = byId('drawerBody');
  if (!d) {
    if (!task.err) return; // keep the loading row
    var eb = body.querySelector('klh-err-banner');
    if (!eb) {
      body.setAttribute('data-sig', '');
      eb = document.createElement('klh-err-banner');
      eb.feed = 'task';
      body.replaceChildren(eb);
    }
    eb.text = 'task unavailable — ' + String(task.err).slice(0, 120);
    return;
  }
  var t = d.task;
  var meta = '<div class="r"><span class="dim">state</span> ' + taskPill(displayState(t)) + '</div>' +
    '<div class="r"><span class="dim">owner</span> ' + esc(t.owner_label || (t.owner_sid ? String(t.owner_sid).slice(0, 12) : '') || 'unclaimed') + '</div>' +
    (t.origin ? '<div class="r"><span class="dim">origin</span> <span class="mono">' + esc(String(t.origin)) + '</span></div>' : '') +
    '<div class="r"><span class="dim">project</span> <span class="mono">' + esc(t.project || '?') + '</span></div>' +
    (t.requires ? '<div class="r"><span class="dim">needs</span> <span class="rq mono">' + esc(String(t.requires)) + '</span></div>' : '') +
    (t.scope ? '<div class="r"><span class="dim">scope</span> <span class="mono">' + esc(String(t.scope)) + '</span></div>' : '') +
    (t.parent_id ? '<div class="r"><span class="dim">parent</span> ' + esc(t.parent_id) + '</div>' : '') +
    '<div class="r"><span class="dim">age</span> ' + ago(t.age_s) + '</div>' +
    '<div class="r"><span class="dim">open decisions</span> ' + (t.open_decisions || 0) + '</div>';
  if (t.state === 'WAITING') meta += '<div class="r"><span class="dim">waiting for</span> ' + esc(t.wait_kind || 'external') + '</div>' +
    '<div class="r"><span class="dim">reason</span> ' + esc(t.wait_reason || '') + '</div>' +
    (t.wait_until_utc ? '<div class="r"><span class="dim">earliest wake</span> ' + esc(t.wait_until_utc) + '</div>' : '');
  var failure = t.failure_note ? '<div class="feed failure-detail"><h2>' + (t.state === 'WAITING' ? 'Previous failure' : 'Failure reason') + '</h2><p>' + esc(String(t.failure_note)) + '</p>' + (t.tail && t.tail.text ? '<h3>Recent output excerpt</h3><p>' + esc(String(t.tail.text)) + '</p>' : '') + '</div>' : '';
  var decs = '';
  var dl = d.decisions || [];
  for (var i = 0; i < dl.length; i++) {
    var dd = dl[i] || {};
    decs += '<div class="dd"><span class="pill hst' + (dd.state === 'OPEN' ? ' open' : '') + '">' + esc(String(dd.state || '?').toLowerCase()) + '</span> ' +
      '<span class="hq">' + esc(String(dd.question || '').slice(0, 120)) + '</span>' +
      (dd.answer_note ? '<span class="hans">' + esc(String(dd.answer_note).slice(0, 160)) + '</span>' : '') + '</div>';
  }
  if (!decs) decs = '<div class="r"><span class="dim">(none)</span></div>';
  // Actions feed: cancel (reason-required) + second opinion. The reason
  // draft + its focus survive the 5s drawer re-render (capture → render → restore).
  var prevReason = byId('acancel');
  var keepReason = prevReason ? prevReason.value : '';
  var reasonFocused = !!(prevReason && document.activeElement === prevReason);
  var acts = '<div class="drawerAction"><label for="acancel">Cancel this item</label><div class="drawerActionControls">' +
    '<input id="acancel" type="text" maxlength="300" placeholder="Reason for cancellation" value="' + esc(keepReason) + '">' +
    '<button type="button" class="retry" id="acancelBtn">Cancel item</button></div></div>' +
    '<div class="drawerAction"><label for="asop">Second opinion</label><div class="drawerActionControls">' +
    '<select id="asop" aria-label="second-opinion executor">' + execOptions(defaultPick(t)) + '</select>' +
    '<button type="button" class="retry" id="asopBtn">Request review</button></div></div>';
  var html = '<div class="feed"><h2>Details</h2>' + meta + '</div>' + failure +
    spendStripHtml(t, 'kspend-drawer') +
    '<div class="feed"><h2>Linked decisions</h2>' + decs + '</div>' +
    '<div class="feed"><h2>Actions</h2>' + acts + '</div>';
  if (task.err) html += '<div class="derr">refresh failed — ' + esc(String(task.err).slice(0, 120)) + '</div>';
  sigSet(body, String(task.okAt) + '|' + (task.err || ''), html);
  var traceHost = body.querySelector('klh-task-trace') || document.createElement('klh-task-trace');
  traceHost.trace = Array.isArray(d.trace) ? d.trace : [];
  traceHost.events = d.events;
  traceHost.execution = task.execution;
  traceHost.loading = task.executionBusy;
  traceHost.error = task.executionErr;
  if (!traceHost.isConnected) {
    var actions = body.querySelector('.feed:last-of-type');
    if (actions) body.insertBefore(traceHost, actions);
    else body.appendChild(traceHost);
  }
  // reason draft: restore focus + caret after the re-render
  var nr = byId('acancel');
  if (nr && keepReason) {
    nr.value = keepReason;
    if (reasonFocused) { nr.focus(); nr.setSelectionRange(nr.value.length, nr.value.length); }
  }
  var cb = byId('acancelBtn');
  if (cb) cb.addEventListener('click', function(){ cancelItem(t.id, t.project, byId('acancel').value, cb); });
  var sb = byId('asopBtn');
  if (sb) sb.addEventListener('click', function(){ secondOpinion(t.id, t.project, byId('asop').value, sb); });
  paintSparks(body);
  renderTaskDiff();
  renderTaskTail();
}
`;
