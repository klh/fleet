// hooks/board-html/tabs.ts — tab shell + wiring (W157 client chunk).
// String.raw matches the original single-template semantics; bun's
// non-ASCII escaping in String.raw reproduces the served page bytes.
export const TABS = String.raw`// --- 7: tab shell (location.hash driven, deep-linkable, back/forward) ---
function pollActiveTab(){
  if (curTab === 'tasks' || curTab === 'lanes') pollTasks();
  else if (curTab === 'activity') pollAct();
  else if (curTab === 'decisions') pollHist(); // no-op while history is collapsed
  else if (curTab === 'setup') pollSetup();
  else if (curTab === 'usage') pollUsage();
  // governor rides /api/data
}
function renderTab(){
  if (curTab === 'decisions') renderHist();
  else if (curTab === 'tasks') renderTasks();
  else if (curTab === 'lanes') renderKanban();
  else if (curTab === 'activity') renderAct();
  else if (curTab === 'usage') pollUsage();
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
  renderTasks(); renderKanban(); renderDecisions();
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
byId('decToggle').addEventListener('click', function(){ setCollapsed(!decCollapsed); });
byId('needsn').addEventListener('click', function(){
  setTab('decisions');
  if (decCollapsed) setCollapsed(false);
  byId('decisions').scrollIntoView({ behavior: 'smooth', block: 'start' });
});
byId('histHead').addEventListener('click', function(){
  histOpen = !histOpen;
  byId('histHead').setAttribute('aria-expanded', histOpen ? 'true' : 'false');
  setText(byId('histCaret'), histOpen ? '-' : '+');
  byId('histBody').style.display = histOpen ? 'block' : 'none';
  if (histOpen) pollHist();
  renderHist();
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
  projBaseline = true; // fresh scope — re-baseline toasts
  lastDec = null; decLoaded = false; decErr = null; decOkAt = 0;
  histData = null; histLoaded = false; histErr = null; histOkAt = 0;
  actData = null; actLoaded = false; actErr = null; actOkAt = 0; actDrill = null;
  byId('histBody').replaceChildren();
  fleetHistoryPage = 0;
  renderAll();
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
