// hooks/board-html/tabs.ts — tab shell + wiring (W157 client chunk).
// String.raw matches the original single-template semantics; bun's
// non-ASCII escaping in String.raw reproduces the served page bytes.
export const TABS = String.raw`// --- 7: tab shell (location.hash driven, deep-linkable, back/forward) ---
// tab entry: a forced kick of the tab's feed (fresh data on every switch);
// the 1Hz cadence afterwards is the feed store's (tick → feeds.kickDue)
function pollActiveTab(){
  if (curTab === 'tasks' || (curTab === 'lanes' && lanesView === 'cards')) pollTasks();
  else if (curTab === 'lanes') feeds.kick('lanesTable', true);
  else if (curTab === 'activity') pollAct();
  else if (curTab === 'decisions') { if (feeds && feeds.kick) feeds.kick('hist', true); } // no-op while history is collapsed (url() gates)
  else if (curTab === 'setup') pollSetup();
  else if (curTab === 'usage') pollUsage();
  else if (curTab === 'report') pollReport(); // W1198 live work-report pane
  // governor rides /api/data
}
function renderTab(){
  if (curTab === 'tasks') renderTasks();
  else if (curTab === 'lanes') { renderLanesTable(); renderKanban(); }
  else if (curTab === 'activity') renderAct();
  else if (curTab === 'usage') pollUsage();
  else if (curTab === 'report') renderReport(); // W1198 live work-report pane
  else if (curTab === 'governor') { if (lastData) { renderFleet(); renderClaims(lastData); renderFacts(lastData); renderDone(lastData); renderEvents(lastData); renderLlm(lastData); } }  else if (curTab === 'setup') renderSetup();
}
var nav = byId('boardTabs'); // <klh-board-tabs> (W695.3.6): owns the buttons, emits tab-select
function setTab(id, fromHash){
  if (!TABS[id]) id = 'decisions';
  var changed = curTab !== id;
  curTab = id;
  nav.current = id;
  byId('boardSearch').parentElement.hidden = id !== 'tasks' && id !== 'lanes' && id !== 'decisions';
  for (var name in TABS) byId('tab-' + name).hidden = name !== id;
  if (!fromHash && location.hash !== '#' + id) location.hash = id;
  pollActiveTab();
  renderTab();
  if (changed) window.scrollTo(0, 0);
}
// --- wiring ---
nav.addEventListener('tab-select', function(e){ setTab(e.detail); });
byId('boardSearch').addEventListener('input', function(e){
  boardQuery = String(e.target.value || '').trim();
  renderTasks(); renderKanban();
  var el = document.querySelector('klh-decisions-mediator');
  if (el && el.refresh) el.refresh(); // the decisions family re-filters itself
});
// W775.1: the enterprise zone registers its tab when the overlay is
// entitled (the zone probes /api/entitlements; a core SKU never fires
// this, so the core page is byte-stable). #enterprise deep-links once
// the tab exists; before that the setTab coercion lands on Decisions.
window.addEventListener('ent-entitled', function(){
  if (TABS.enterprise) return;
  TABS.enterprise = 1;
  nav.extraTabs = [['enterprise', 'Enterprise']];
  if (location.hash === '#enterprise') setTab('enterprise', true);
});
window.addEventListener('hashchange', function(){
  applyHashRoute(); // W890 query-style tab hashes — tab switch + w/project/q params
  var h = (location.hash || '').replace(/^#/, '');
  if (TABS[h]) setTab(h, true);
  applyHashFilter(); // #filter= legacy form; ?q/?filter arrive via hashNeedle
  applyHashTask();
});
// #task=<id>[&proj=<p>] deep-link — open the task drawer straight from a URL
// (lane reports, notifications, terminal links all land here)
function applyHashTask(){
  var m = (location.hash || '').match(/^#task=([^&]+)(?:&proj=([^&]*))?/);
  if (m && openTask) {
    var id = decodeURIComponent(m[1]), project = m[2] ? decodeURIComponent(m[2]) : null;
    if (task.id !== id || task.proj !== project) openTask(id, project, null);
  } else if (task.id) {
    // W1294.2: a W890 query-style hash with an item param owns the drawer —
    // #lanes?w=<id> opened it at boot; the missing #task= match must not close it
    var q = parseHashQuery(location.hash || '').params;
    if (q.w === undefined && q.task === undefined && q.id === undefined) closeTask(true);
  }
}
byId('hashChipBar').addEventListener('click', function(e){
  var b = e.target.closest && e.target.closest('.hfclear');
  if (!b) return;
  history.replaceState(null, '', location.pathname + location.search); // empty hash = no filtering
  applyHashFilter();
});
byId('tasksTbl').addEventListener('click', function(e){
  var b = e.target.closest && e.target.closest('[data-task]');
  if (b) openTask(b.getAttribute('data-task'), b.getAttribute('data-proj'), b);
});
byId('kanban').addEventListener('click', function(e){
  // W2267.4.2.2 — a click composed out of the Lit card's shadow DOM
  // retargets to the host element, so every interior click would match
  // .kcard below and pop the drawer. The card's typed events
  // (task-card-action-requested / task-card-open-requested) own ALL
  // semantics inside a host card; the legacy fallthrough never fires there.
  if (e.target.closest && e.target.closest('klh-task-card-host')) return;
  var o = e.target.closest && e.target.closest('[data-orch]');
  if (o) { activateOrchForTask(o.getAttribute('data-orch'), o.getAttribute('data-orchproj')); return; }
  var s = e.target.closest && e.target.closest('[data-start]');
  if (s) {
    var card = s.closest('.kcard');
    var selEl = card ? card.querySelector('.kexecsel') : null;
    var effEl = card ? card.querySelector('.keffortsel') : null;
    startItem(s.getAttribute('data-start'), s.getAttribute('data-startproj'), s, selEl ? selEl.value : 'claude', effEl ? effEl.value : '');
    return;
  }
  // W182 — claimed-card lifecycle: reassign (release + re-dispatch) / unclaim
  var r = e.target.closest && e.target.closest('[data-reassign]');
  if (r) {
    var rcard = r.closest('.kcard');
    var rsel = rcard ? rcard.querySelector('.kexecsel') : null;
    reassignItem(r.getAttribute('data-reassign'), r.getAttribute('data-reassignproj'), r, rsel ? rsel.value : 'claude');
    return;
  }
  var u = e.target.closest && e.target.closest('[data-unclaim]');
  if (u) {
    unclaimItem(u.getAttribute('data-unclaim'), u.getAttribute('data-unclaimproj'), u, false);
    return;
  }
  // W970 — FAILED-card requeue (operator-gated items confirm-then-force)
  var rt = e.target.closest('[data-retry]');
  if (rt) {
    retryItem(rt.getAttribute('data-retry'), rt.getAttribute('data-retryproj'), rt, false);
    return;
  }
  // executor/effort pick — selecting a lane is not a card open (the click
  // would otherwise fall through to .kcard and pop the task drawer mid-pick)
  if (e.target.classList && (e.target.classList.contains('kexecsel') || e.target.classList.contains('keffortsel'))) return;
  var b = e.target.closest && e.target.closest('[data-task]');
  if (b) { openTask(b.getAttribute('data-task'), b.getAttribute('data-proj'), b); return; }
  var c = e.target.closest && e.target.closest('.kcard');
  if (c) openTask(c.getAttribute('data-kid'), c.getAttribute('data-kproj'), c);
});
byId('kanban').addEventListener('change', function(e){
  var s = e.target.classList && e.target.classList.contains('kexecsel') ? e.target : null;
  if (!s) return;
  var card = s.closest('.kcard');
  if (card) execPick[(card.getAttribute('data-kproj') || '') + '\u0000' + (card.getAttribute('data-kid') || '')] = s.value;
});
// W2267.4.2.2 — the Lit card's typed events (composed: they bubble out of
// the card's shadow footer through the host's light DOM to here). One
// listener per event name; the live footer select value rides the shadow
// query (the card's draft stays shadow-scoped, the verb needs the value).
function cardLivePick(host){
  var card = host.querySelector('klh-task-card');
  if (!card || !card.shadowRoot) return '';
  var sel = card.shadowRoot.querySelector('select.seg');
  return sel ? sel.value : '';
}
function cardLiveEffort(host){
  var card = host.querySelector('klh-task-card');
  if (!card || !card.shadowRoot) return '';
  var sels = card.shadowRoot.querySelectorAll('select.seg');
  for (var i = 0; i < sels.length; i++)
    if ((sels[i].getAttribute('aria-label') || '').indexOf('reasoning effort') >= 0) return sels[i].value;
  return '';
}
// Root #103404 — unsubmitted executor/effort drafts bank here (the page
// maps survive the structural rebuilds that recreate every host); the
// event's own fields are the value (the shadow select retargets to the
// host on the page listener, so e.target can't be read directly).
byId('kanban').addEventListener('task-card-draft-changed', function(e){
  var k = (e.project || '') + '\u0000' + e.id;
  if (e.executor != null) execPick[k] = e.executor;
  if (e.effort != null) effortPick[k] = e.effort;
});
byId('kanban').addEventListener('task-card-action-requested', function(e){
  var host = e.target instanceof Element ? e.target.closest('klh-task-card-host') : null;
  if (!host) return;
  var a = e.action, id = e.id, proj = e.project || '';
  var pick = cardLivePick(host);
  // W2267.4.2.2 (#103127) — mediator-owned pending state, data-down to the
  // card model: the stamp lives in the rebuild-proof cardPending map (a
  // structural render re-creates hosts), the verbs still refuse concurrent
  // fire through their own starting/recoveryBusy maps, and the stamp clears
  // when the verb's promise settles — every leg now returns it, network
  // failure included. The leaf card never self-serves: it renders the state.
  var pk = proj + '\u0000' + id;
  var run = null;
  if (a === 'start') run = startItem(id, proj, null, pick || 'claude', cardLiveEffort(host));
  else if (a === 'retry') run = window.__klhRecovery.retryExecItem(id, proj, null, false, pick || null);
  else if (a === 'recover') run = window.__klhRecovery.recoverItem(id, proj, null, false);
  else if (a === 'reassign') run = reassignItem(id, proj, null, pick || 'claude');
  else if (a === 'release') run = unclaimItem(id, proj, null, false);
  else if (a === 'prompt') activateOrchForTask(id, proj);
  else if (a === 'report') window.open('/api/report/' + encodeURIComponent(id) + '?project=' + encodeURIComponent(proj), '_blank', 'noopener');
  if (run && typeof run.then === 'function') {
    cardPending[pk] = a;
    host.pendingAction = a;
    var settle = function(){
      delete cardPending[pk];
      // the host may have been re-created by a structural render; clear
      // whatever element currently carries the card's identity
      var live = document.querySelectorAll('klh-task-card-host[data-kid="' + CSS.escape(id) + '"][data-kproj="' + CSS.escape(proj) + '"]');
      for (var i = 0; i < live.length; i++) live[i].pendingAction = '';
    };
    run.then(settle, settle);
  }
});
byId('kanban').addEventListener('task-card-open-requested', function(e){
  var host = e.target instanceof Element ? e.target.closest('klh-task-card-host') : null;
  if (!host) return;
  var card = host.querySelector('klh-task-card');
  var tidBtn = card && card.shadowRoot ? card.shadowRoot.querySelector('.tid') : null;
  openTask(e.id, e.project || '', tidBtn);
});
var theadEl = document.querySelector('#tasksTbl thead');
if (theadEl) theadEl.addEventListener('click', function(e){
  var b = e.target && e.target.closest ? e.target.closest('.thsort') : null;
  if (!b) return;
  var th = b.closest('th');
  var k = th ? th.getAttribute('data-k') : null;
  if (!k) return;
  if (taskSort.key === k) taskSort.dir = -taskSort.dir;
  else { taskSort.key = k; taskSort.dir = 1; }
  saveTaskView(); paintSort(); renderTasks();
});
var ownSel = byId('taskOwner');
if (ownSel) ownSel.addEventListener('change', function(e){
  taskOwner = e.target.value || 'all';
  saveTaskView(); renderTasks();
});
byId('taskPriority').addEventListener('click', function(){
  taskSort = {key: 'priority', dir: 1};
  saveTaskView(); paintSort(); renderTasks();
});
byId('taskDetails').addEventListener('click', function(){
  taskExpanded = !taskExpanded;
  saveTaskView(); renderTasks();
});
byId('taskFocus').addEventListener('click', function(e){
  var button = e.target.closest('[data-focus]');
  if (!button) return;
  taskFocus = button.getAttribute('data-focus') || 'all';
  saveTaskView(); renderTasks();
});
var doneCb = byId('taskDone');
if (doneCb) doneCb.addEventListener('change', function(e){
  try { localStorage.setItem('taskShowDone', e.target.checked ? '1' : '0'); } catch(err) {}
  renderTasks();
  pollTasks(); // W682: the feed depth changed — refetch (done=12 vs done=all)
});
paintSort();
byId('drawerClose').addEventListener('click', closeTask);
var diffEl = byId('taskDiff');
diffEl.addEventListener('click', function(e){
  var sh = e.target.closest && e.target.closest('.diffbtn.ship');
  if (sh) { shipItem(); return; }
  var b = e.target.closest && e.target.closest('.diffbtn');
  if (b) { toggleDiff(); return; }
  var n = e.target.closest && e.target.closest('.dlnum[data-file]');
  if (n) { pickDiffLine(n.getAttribute('data-file'), n.getAttribute('data-line')); return; }
  var s = e.target.closest && e.target.closest('.diffsend');
  if (s) sendDiffNote();
});
diffEl.addEventListener('input', function(e){
  if (e.target.classList && e.target.classList.contains('diffnote')) diffView.draft = e.target.value;
});
diffEl.addEventListener('keydown', function(e){
  if (e.key === 'Enter' && e.target.classList && e.target.classList.contains('diffnote')) { e.preventDefault(); sendDiffNote(); }
});
var tailEl = byId('taskTail');
tailEl.addEventListener('click', function(e){
  var b = e.target.closest && e.target.closest('.tailbtn');
  if (b) { toggleTail(); return; }
  var s = e.target.closest && e.target.closest('.lanesend');
  if (s) sendLaneMsg();
});
tailEl.addEventListener('input', function(e){
  if (e.target.classList && e.target.classList.contains('lanemsg')) tailView.draft = e.target.value;
});
tailEl.addEventListener('keydown', function(e){
  if (e.key === 'Enter' && e.target.classList && e.target.classList.contains('lanemsg')) { e.preventDefault(); sendLaneMsg(); }
});
byId('setupBody').addEventListener('click', function(e){
  var b = e.target.closest && e.target.closest('.copyfix');
  if (!b) return;
  var fix = b.getAttribute('data-fix') || '';
  navigator.clipboard.writeText(fix).then(function(){ toast('copied to clipboard'); }, function(){ toast('copy failed — select the command text'); });
});
byId('needsn').addEventListener('click', function(){
  setTab('decisions');
  setCollapsed(false);
  var sec = document.getElementById('decisions');
  if (sec) sec.scrollIntoView({ behavior: 'smooth', block: 'start' });
});
byId('fleetHead').addEventListener('click', function(){
  var b = byId('fleetBody');
  var open = b.style.display !== 'none';
  b.style.display = open ? 'none' : 'block';
  setText(byId('fleetCaret'), open ? '+' : '-');
  byId('fleetHead').setAttribute('aria-expanded', open ? 'false' : 'true');
  if (!open) renderFleet();
});
byId('govSearch').addEventListener('input', function(){
  if (!lastData) return;
  var searching = !!this.value.trim();
  byId('fleetBody').style.display = searching ? 'block' : 'none';
  byId('fleetHead').setAttribute('aria-expanded', String(searching));
  setText(byId('fleetCaret'), searching ? '-' : '+');
  if (!searching) document.querySelectorAll('.govpanel').forEach(function(panel){ panel.open = false; });
  renderFleet(); renderClaims(lastData); renderFacts(lastData); renderLlm(lastData); renderDone(lastData); renderEvents(lastData);
});
document.addEventListener('keydown', function(e){
  if (e.key !== 'Escape') return;
  if (task.id) { closeTask(); return; } // drawer first, then the section
  setCollapsed(true); // collapses the section, not the decisions
});
sel.addEventListener('change', function(){
  lastDec = null; decLoaded = false; decOkAt = 0; // openDecs re-fills from the store
  actData = null; actLoaded = false; actErr = null; actOkAt = 0; actDrill = null;
  fleetHistoryPage = 0;
  renderAll();
  feeds.rescope(); // abort the old scope's in-flight requests, fetch the new one (dec/hist ride the same store — the mediator re-baselines its toasts off #proj)
  tick();
});
['originHub', 'peerHub'].forEach(function(id){
  byId(id).addEventListener('change', function(){
    hubOrigin = byId('originHub').value; hubPeer = byId('peerHub').value;
    fleetHistoryPage = 0;
    renderTab(); renderAct();
  });
});
`;
