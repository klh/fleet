// hooks/board-html/tasks.ts — tasks table + kanban + drawer (W157 client chunk).
// String.raw matches the original single-template semantics; bun's
// non-ASCII escaping in String.raw reproduces the served page bytes.
export const TASKS = String.raw`// --- 4: tasks table (Tasks tab, /api/tasks) + drawer (/api/task) ---
// view state: session filter + column sort, persisted per browser (owner
// asked: filter tasks by owning session, sortable table, fragments grouped)
var taskSort = {key: 'priority', dir: 1};
var taskOwner = 'all';
var taskFocus = 'all';
var taskExpanded = false;
try {
  var savedSort = JSON.parse(localStorage.getItem('sb.taskSort') || 'null');
  if (savedSort && savedSort.key) taskSort = savedSort;
  var savedOwner = localStorage.getItem('sb.taskOwner');
  if (savedOwner) taskOwner = String(savedOwner);
  var savedFocus = localStorage.getItem('sb.taskFocus');
  if (['all', 'attention', 'working', 'ready', 'waiting'].includes(savedFocus)) taskFocus = savedFocus;
  taskExpanded = localStorage.getItem('sb.taskExpanded') === '1';
} catch (e) {}
function saveTaskView(){
  try { localStorage.setItem('sb.taskSort', JSON.stringify(taskSort)); localStorage.setItem('sb.taskOwner', taskOwner); localStorage.setItem('sb.taskFocus', taskFocus); localStorage.setItem('sb.taskExpanded', taskExpanded ? '1' : '0'); } catch (e) {}
}
function projShort(p){ return String(p || '').replace(/\/\.git$/, '').split('/').pop() || '—'; }
function ownerKey(t){ return t.owner_sid ? String(t.owner_sid) : 'unclaimed'; }
var ownerDisp = {}; // sid → display label, rebuilt per poll; shared intent labels get the sid appended
function ownerLabel(t){
  var sid = t.owner_sid ? String(t.owner_sid) : '';
  if (!sid) return 'unclaimed';
  var label = String(t.owner_label || '').trim();
  if (label && label !== sid && !/^[0-9a-f]{8}-[0-9a-f-]{27,}$/i.test(label)) return label;
  var groups = t.spend && t.spend.model_groups ? t.spend.model_groups : null;
  var top = '', count = -1;
  if (groups) for (var model in groups){
    var requests = Number(groups[model] && groups[model].requests || 0);
    if (requests > count){ top = model; count = requests; }
  }
  return top || t.model || ('session ' + sid.slice(0, 8));
}
function ownerName(t){
  var s = t.owner_sid ? String(t.owner_sid) : '';
  if (s && ownerDisp[s]) return ownerDisp[s];
  return ownerLabel(t);
}
function buildOwnerDisp(ts){ // seven lanes all claiming "work-graph" must stay distinguishable
  var sidLabel = {}, byLabel = {};
  for (var i = 0; i < ts.length; i++){
    var s = ts[i].owner_sid ? String(ts[i].owner_sid) : '';
    if (!s) continue;
    var l = ownerLabel(ts[i]);
    if (!sidLabel[s] || (sidLabel[s].slice(0, 8) === 'session ' && l.slice(0, 8) !== 'session ')) sidLabel[s] = l;
  }
  for (var sid in sidLabel) (byLabel[sidLabel[sid]] || (byLabel[sidLabel[sid]] = {}))[sid] = 1;
  ownerDisp = {};
  for (var s2 in sidLabel){
    var l2 = sidLabel[s2];
    var n = 0; for (var x in byLabel[l2]) n++;
    ownerDisp[s2] = n > 1 ? l2 + ' (' + s2.slice(0, 12) + ')' : l2;
  }
}
function taskSortVal(t, k){
  if (k === 'priority') return taskRank(t);
  if (k === 'age') return Number(t.age_s || 0);
  if (k === 'decisions') return Number(t.open_decisions || 0);
  if (k === 'tok') return Number(t.spend ? t.spend.fresh + t.spend.cached + t.spend.out : 0);
  if (k === 'wall') return Number(t.spend ? t.spend.wall_ms : 0);
  if (k === 'owner') return ownerName(t).toLowerCase();
  if (k === 'proj') return projShort(t.project).toLowerCase();
  var s2 = String(k === 'title' ? t.title : k === 'state' ? t.state : t.id || '');
  return s2.toLowerCase();
}
function sortTasks(arr){
  var k = taskSort.key, d = taskSort.dir;
  arr.sort(function(a, b){
    var va = taskSortVal(a, k), vb = taskSortVal(b, k);
    var cmp = (typeof va === 'number' ? va - vb : String(va).localeCompare(String(vb))) * d;
    return cmp || Number(a.age_s || 0) - Number(b.age_s || 0);
  });
}
function taskBucket(t){
  var state = displayState(t);
  if (state === 'FAILED' || state === 'BLOCKED' || Number(t.open_decisions || 0) > 0) return 'attention';
  if (state === 'CLAIMED' || state === 'RUNNING') return 'working';
  if (state === 'READY') return 'ready';
  return 'waiting';
}
function taskRank(t){
  var bucket = taskBucket(t);
  return bucket === 'attention' ? 0 : bucket === 'working' ? 1 : bucket === 'ready' ? 2 : 3;
}
function taskGroupKey(t){ return String(t.project || '') + '\u0000' + String(t.id); }
function taskGroups(ts){ // fragments nest under their parent row, scoped by project
  var byIdMap = {}, roots = [], kids = {};
  for (var i = 0; i < ts.length; i++) byIdMap[taskGroupKey(ts[i])] = ts[i];
  for (var j = 0; j < ts.length; j++){
    var t = ts[j], id = String(t.id), dot = id.lastIndexOf('.');
    var pid = t.parent_id || (dot > 0 ? id.slice(0, dot) : null);
    var pkey = String(t.project || '') + '\u0000' + pid;
    if (pid && byIdMap[pkey]) (kids[pkey] || (kids[pkey] = [])).push(t);
    else roots.push(t);
  }
  return {roots: roots, kids: kids};
}
function renderTaskOwnerOptions(ts){
  var sel = byId('taskOwner');
  var seen = {}, names = [];
  for (var i = 0; i < ts.length; i++){
    var k = ownerKey(ts[i]);
    if (!seen[k]) { seen[k] = ownerName(ts[i]); names.push([k, seen[k]]); }
  }
  names.sort(function(a, b){ return a[1].localeCompare(b[1]); });
  var html = '<option value="all">all sessions</option>';
  for (var j = 0; j < names.length; j++) html += '<option value="' + esc(names[j][0]) + '">' + esc(names[j][1]) + '</option>';
  if (sel.dataset.sig === html) return; // the option-list string stays the dedupe key; options build natively
  sel.dataset.sig = html;
  while (sel.options.length > 0) sel.remove(0);
  sel.add(new Option('all sessions', 'all'));
  for (var j = 0; j < names.length; j++) sel.add(new Option(names[j][1], names[j][0]));
  var has = false;
  for (var o = 0; o < sel.options.length; o++) if (sel.options[o].value === taskOwner) has = true;
  if (!has) { taskOwner = 'all'; saveTaskView(); }
  sel.value = taskOwner;
}
function paintSort(){
  var priority = byId('taskPriority');
  if (priority) priority.setAttribute('aria-pressed', taskSort.key === 'priority' ? 'true' : 'false');
  var ths = document.querySelectorAll('#tasksTbl th');
  for (var i = 0; i < ths.length; i++){
    var th = ths[i], k = th.getAttribute('data-k');
    var b = th.querySelector('.thsort');
    if (!k || !b) continue;
    var active = k === taskSort.key;
    th.setAttribute('aria-sort', active ? (taskSort.dir === 1 ? 'ascending' : 'descending') : 'none');
    b.textContent = (b.getAttribute('data-label') || '') + (active ? (taskSort.dir === 1 ? ' \u25B4' : ' \u25BE') : '');
  }
}
function pollTasks(){
  if (tasksBusy || (curTab !== 'tasks' && curTab !== 'lanes')) return;
  tasksBusy = true;
  // W682: the server trims terminal history to 12/project by default; the
  // opt-in completed table asks for the full feed back.
  var showDone = false;
  try { showDone = localStorage.getItem('taskShowDone') === '1'; } catch(e) {}
  var dq = 'done=' + (showDone ? 'all' : '12');
  fetch('/api/tasks' + projQuery() + (projQuery() ? '&' : '?') + dq, { signal: AbortSignal.timeout(8000) })
    .then(function(r){ if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
    .then(function(j){
      if (!j || j.ok === false || !Array.isArray(j.tasks)) throw new Error('bad /api/tasks payload');
      tasksData = j; tasksOkAt = Date.now(); tasksErr = null; tasksLoaded = true;
      noteProjects(j.projects);
    })
    .catch(function(e){ tasksErr = String((e && e.message) || e); })
    .finally(function(){ tasksBusy = false; renderTasks(); renderKanban(); });
}
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
  return s;
}
function spendStripHtml(t, cls){
  var sp = t && t.spend ? t.spend : null;
  if (!sp) return '';
  var key = esc(String(t.project || '')) + '|' + esc(String(t.id));
  var inner = fmtTokShort(sp.fresh + sp.cached + sp.out) + ' tok · ' + spendStripText(sp);
  return '<div class="kspend' + (cls ? ' ' + cls : '') + ' dim"><div class="ksparkplot"><span class="kspark" data-spark="' + key + '"></span><div class="ksparkaxis"><span>first request</span><span>latest</span></div></div><span class="kspendtxt" title="Attributed totals for this work item">' + esc(inner) + '</span></div>';
}
function displayState(t){
  return t.state === 'READY' && t.blocked_by && t.blocked_by.length ? 'BLOCKED' : t.state;
}
function laneStamp(s){
  if (!s) return '';
  var d = new Date(s); if (isNaN(d.getTime())) return esc(s);
  var p = function(n){ return (n < 10 ? '0' : '') + n; };
  var short = p(d.getDate()) + '.' + p(d.getMonth() + 1) + '.' + String(d.getFullYear()).slice(-2) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
  var full = d.toLocaleString('da-DK', {dateStyle:'full', timeStyle:'long'}) + ' · UTC ' + d.toISOString();
  return '<time datetime="' + esc(d.toISOString()) + '" title="' + esc(full) + '">' + esc(short) + '</time>';
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
    clearErr(errEl);
    sigSet(body, 'loading', '<tr><td colspan="9" class="dim">loading tasks...</td></tr>');
    return;
  }
  if (tasksErr) {
    var when = tasksOkAt ? ago(Math.round((Date.now() - tasksOkAt) / 1000)) : 'never';
    errBanner(errEl, 'task list unavailable — last good ' + when, function(){ tasksErr = null; pollTasks(); });
  } else {
    clearErr(errEl);
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
  var counts = {all: open.length, attention: 0, working: 0, ready: 0, waiting: 0};
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
  if (cnt) cnt.textContent = pool.length === ts.length ? pool.length + ' tasks' : pool.length + ' of ' + ts.length + ' tasks';
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
  { key: 'ACTIVE', label: 'working', states: ['CLAIMED', 'RUNNING'] },
  { key: 'WAITING', label: 'waiting', states: ['WAITING', 'SHATTERED'], cap: 12 },
  { key: 'BLOCKED', label: 'blocked', states: ['BLOCKED', 'PAUSED'] },
  { key: 'FAILED', label: 'failed', states: ['FAILED'] },
  { key: 'DONE', label: 'done', states: ['DONE'], cap: 12 },
  { key: 'CANCELLED', label: 'cancelled', states: ['CANCELLED'], cap: 12 }
];
function ensureKstatusNav(){
  var nav = byId('kstatusnav');
  if (!nav || nav.childElementCount) return;
  for (var i = 0; i < KCOLS.length; i++) {
    var button = document.createElement('button');
    button.type = 'button';
    button.setAttribute('data-kcol', String(i));
    button.textContent = KCOLS[i].label;
    nav.appendChild(button);
  }
  nav.addEventListener('click', function(e){
    var button = e.target.closest && e.target.closest('button[data-kcol]');
    if (!button) return;
    var col = byId('kanban').querySelectorAll('.kcol')[Number(button.getAttribute('data-kcol'))];
    var wrap = byId('kanban').parentElement;
    if (!col || !wrap) return;
    wrap.scrollTo({ left: wrap.scrollLeft + col.getBoundingClientRect().left - wrap.getBoundingClientRect().left, behavior: 'smooth' });
  });
}
var starting = {}; // 'proj\u0000id' -> start POST in flight (rebuild-proof)
var execPick = {}; // 'proj\u0000id' -> chosen executor (survives card rebuilds)
var execOpts = [
  { value: 'claude', label: 'claude', plane: 'remote', reasoningEffort: false },
  { value: 'codex', label: 'codex', plane: 'remote', reasoningEffort: false },
  { value: 'copilot', label: 'copilot', plane: 'remote', reasoningEffort: true }
];
// W183.1 — bracketed text badges (plain <select>/<option> can't do rich
// icons cross-browser): [L] this machine's swarm, [R] remote/cloud,
// [HUB] prefix added on top when the entry is federation-entitled.
function execBadge(x){
  var loc = x.locality === 'local' || x.plane === 'local' ? 'L' : 'R';
  return (x.plane === 'hub' ? '[HUB] ' : '') + '[' + loc + '] ';
}
var EFFORT_LEVELS = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
function pollExecutors(){
  fetch('/api/executors', { signal: AbortSignal.timeout(8000) })
    .then(function(r){ return r.json(); })
    .then(function(j){
      if (!j || j.ok === false || !Array.isArray(j.executors)) return;
      var opts = [];
      var seen = new Set();
      for (var i = 0; i < j.executors.length; i++) {
        var x = j.executors[i];
        if (x && x.value && !seen.has(String(x.value))) {
          seen.add(String(x.value));
          opts.push({
          value: String(x.value), label: String(x.label || x.value),
          locality: String(x.locality || 'remote'), plane: String(x.plane || 'remote'),
          reasoningEffort: !!x.reasoningEffort
          });
        }
      }
      if (opts.length >= 2) execOpts = opts;
      renderKanban(); // repaint cards with the live belt targets
    })
    .catch(function(){}); // dropdown falls back to claude/codex/copilot only
}
function startItem(id, proj, btn, agent, effort){
  var k = proj + '\u0000' + id;
  if (starting[k]) return;
  starting[k] = true;
  if (btn) btn.disabled = true;
  var body = { project: proj, id: id, agent: agent || 'claude' };
  if (effort) body.effort = effort; // W183.1 — copilot reasoning-effort dial
  postJSON('/api/start', body).then(function(j){
    delete starting[k];
    if (j && j.ok) toast('dispatching ' + id + ' on ' + (agent || 'claude') + ' — lane ' + String(j.sid || ''));
    else toast('start failed: ' + String((j && j.error) || 'unknown error'));
    pollTasks();
  });
}
// W182 — claimed-card lifecycle: reassign (release + re-dispatch on the
// chosen executor, same deterministic sid — capsule IS the handoff) and
// unclaim (release; a live lane 409s {live:true} → confirm offers force,
// which signals it to bank its capsule and exit first).
function reassignItem(id, proj, btn, agent){
  var k = proj + '\u0000' + id;
  if (starting[k]) return;
  starting[k] = true;
  if (btn) btn.disabled = true;
  postJSON('/api/reassign', { project: proj, id: id, agent: agent || 'claude' }).then(function(j){
    delete starting[k];
    if (j && j.ok) toast(j.dispatched === false ? 'old lane signalled to bank + exit — re-dispatch when it retires' : 'reassigning ' + id + ' to ' + (agent || 'claude'));
    else toast('reassign failed: ' + String((j && j.error) || 'unknown error'));
    pollTasks();
  });
}
function unclaimItem(id, proj, btn, force){
  var k = proj + '\u0000' + id;
  if (starting[k]) return;
  starting[k] = true;
  if (btn) btn.disabled = true;
  postJSON('/api/release', { project: proj, id: id, force: !!force }).then(function(j){
    delete starting[k];
    if (j && j.ok) toast('released ' + id + (j.forced ? ' — lane signalled to bank + exit' : ''));
    else if (j && j.live && !force) {
      delete starting[k];
      if (confirm('Lane looks live — force? It will be signalled to bank its capsule and exit.')) unclaimItem(id, proj, null, true);
      else pollTasks();
      return;
    }
    else toast('release failed: ' + String((j && j.error) || 'unknown error'));
    pollTasks();
  });
}
// W182 — cancel: owner-override close with a required reason (terminal
// CANCELLED; server releases the claim + retires the worktree).
function cancelItem(id, proj, reason, btn){
  if (!reason || !reason.trim()) { toast('cancel needs a reason'); return; }
  if (btn) btn.disabled = true;
  postJSON('/api/cancel', { project: proj, id: id, reason: reason.trim() }).then(function(j){
    if (btn) btn.disabled = false;
    if (j && j.ok) { toast('cancelled ' + id); pollTasks(); if (task.id === id) pollTask(true); }
    else toast('cancel failed: ' + String((j && j.error) || 'unknown error'));
  });
}
// W182 — second opinion: spawns a read-only REVIEW lane on the item; the
// verdict lands as a work.review event on the drawer timeline.
function secondOpinion(id, proj, executor, btn){
  if (btn) btn.disabled = true;
  postJSON('/api/second-opinion', { project: proj, id: id, executor: executor }).then(function(j){
    if (btn) btn.disabled = false;
    if (j && j.ok) { toast('second opinion dispatched — ' + executor + ' reviews ' + id); pollTask(true); }
    else toast('second opinion failed: ' + String((j && j.error) || 'unknown error'));
  });
}
// W182 — executor dropdown facts shared by READY + claimed cards: the pick
// survives card rebuilds; options ride the same live executor catalog.
function defaultPick(t){
  var k = t.project + '\u0000' + t.id;
  if (execPick[k]) return execPick[k];
  var prefs = (window.__execPrefs && window.__execPrefs.length) ? window.__execPrefs : ['glm-5.3-flash'];
  for (var pi = 0; pi < prefs.length; pi++) for (var di = 0; di < execOpts.length; di++)
    if (String(execOpts[di].value || '').indexOf(prefs[pi]) >= 0) return execOpts[di].value;
  return 'claude';
}
function execOptions(pick){
  var opts = '';
  for (var xi = 0; xi < execOpts.length; xi++) {
    var xo = execOpts[xi];
    opts += '<option value="' + esc(xo.value) + '"' + (xo.value === pick ? ' selected' : '') + '>' + esc(execBadge(xo) + xo.label) + '</option>';
  }
  return opts;
}
function kanbanCard(t, fam){
  var od = t.open_decisions || 0;
  var startable = displayState(t) === 'READY' && !t.owner_sid;
  var active = (t.state === 'CLAIMED' || t.state === 'RUNNING') && t.owner_sid;
  var kid = fam && fam.nested[String(t.id)];
  var kidStyle = '';
  if (kid) {
    if (kid.c) kidStyle += '--prefer:' + esc(kid.c) + ';';
    kidStyle += 'margin-left:' + (Math.min(kid.d, 2) * 14) + 'px';
  }
  var html = '<div class="kcard' + (kid ? ' kkid' : '') + '"' + (kid ? ' style="' + kidStyle + '"' : preferStyle(t)) + ' data-kid="' + esc(t.id) + '" data-kproj="' + esc(t.project || '') + '" title="open details">';
  if (kid) html += '<span class="kidmark">↳</span>';
  html += '<div class="krow">' + taskPill(displayState(t)) +
    (od ? '<span class="kdec">needs you</span>' : '') +
    (t.updated_at_utc ? '<span class="kcardstamp dim">' + laneStamp(t.updated_at_utc) + '</span>' : '') + '</div>' +
    '<div class="kcardident"><button type="button" class="tidbtn mono" data-task="' + esc(t.id) + '" data-proj="' + esc(t.project || '') + '" aria-haspopup="dialog">' + esc(t.id) + '</button>' +
    '<span class="kage dim">' + agoShort(t.age_s) + '</span></div>';
  html += '<div class="ktitle">' + esc(String(t.title || '(untitled)')).slice(0, 140) + '</div>';
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
  if (t.signal) html += '<div class="ksignal dim">⚑ ' + esc(t.signal.class) + ' · ' + Math.round((t.signal.confidence || 0) * 100) + '%</div>';
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
function renderKanban(){
  if (curTab !== 'lanes') return;
  var el = byId('kanban');
  if (!el) return;
  if (!tasksLoaded && !tasksErr) { sigSet(el, 'loading', '<div class="state dim">loading lanes...</div>'); return; }
  if (tasksErr) {
    errBanner(byId('kanbanErr'), 'lane board unavailable' + (tasksOkAt ? ' — last good ' + ago(Math.round((Date.now() - tasksOkAt) / 1000)) : ''), function(){ tasksErr = null; pollTasks(); });
    if (!tasksData) return; // nothing good yet — banner instead of stale cards
  } else {
    clearErr(byId('kanbanErr'));
  }
  if (!tasksData) return;
  var ts = tasksData.tasks;
  ensureKstatusNav();
  buildOwnerDisp(ts);
  if (hashFilter) ts = ts.filter(function(t){ return hashMatch([t.id, t.title, ownerKey(t), ownerName(t), t.project]); });
  if (boardQuery) ts = ts.filter(function(t){ return boardMatch([t.id, t.title, t.state, ownerKey(t), ownerName(t), t.project]); });
  var html = '<div class="kanban">';
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
    var jump = byId('kstatusnav').querySelectorAll('button')[c];
    if (jump) jump.textContent = col.label + ' ' + resid.length;
    html += '<div class="kcol"><h3>' + esc(col.label) + '<span class="kcount">' + resid.length + '</span></h3>';
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
  var kstruct = html.replace(/<span class="kage dim">[^<]*<\/span>/g, '').replace(/<div class="ktail">[^<]*<\/div>/g, '');
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
    if (ageEl) ageEl.textContent = agoShort(t.age_s);
    var tailEl = c.querySelector('.ktail');
    if (tailEl) tailEl.textContent = (t.tail && t.tail.text) ? t.tail.text : '';
    var sigEl = c.querySelector('.ksignal');
    if (sigEl) sigEl.textContent = t.signal ? '⚑ ' + t.signal.class + ' · ' + Math.round((t.signal.confidence || 0) * 100) + '%' : '';
  }
}
var SVGNS = 'http://www.w3.org/2000/svg';
// --- card sparklines: per-item request spend over time painted
// as stacked bars — fresh = accent, cached = ok. Data rides
// /api/spend-series (30s poll, silent-fail garnish); the .kspark placeholders
// emitted by spendStripHtml get painted here and in the drawer. DOM-safe key:
// esc(project)+'|'+esc(id) (NUL is unusable in attributes).
var spendSeries = {}, spendSeriesAt = 0, spendSeriesBusy = false;
function hideSparkTip(){
  var tip = byId('ksparkTip');
  if (tip) { tip.hidden = true; tip._bar = null; }
}
function showSparkTip(e, bar){
  var tip = byId('ksparkTip');
  if (!tip){
    tip = document.createElement('div');
    tip.id = 'ksparkTip'; tip.className = 'kspark-tip'; tip.setAttribute('role', 'tooltip');
    document.body.appendChild(tip);
  }
  if (tip._bar !== bar){
    var at = Number(bar.getAttribute('data-at'));
    var minutes = Number(bar.getAttribute('data-minutes'));
    var fresh = Number(bar.getAttribute('data-fresh'));
    var cached = Number(bar.getAttribute('data-cached'));
    var out = Number(bar.getAttribute('data-out'));
    var time = new Date(at).toLocaleString('da-DK', {day:'2-digit', month:'2-digit', year:'2-digit', hour:'2-digit', minute:'2-digit'});
    tip.textContent = time + ' · ' + minutes + ' min\nFresh input  ' + fresh.toLocaleString('da-DK') + '\nCached input  ' + cached.toLocaleString('da-DK') + '\nOutput  ' + out.toLocaleString('da-DK');
    tip._bar = bar;
  }
  tip.hidden = false;
  var left = Math.min(e.clientX + 10, window.innerWidth - tip.offsetWidth - 8);
  var above = e.clientY - tip.offsetHeight - 10;
  tip.style.left = Math.max(8, left) + 'px';
  tip.style.top = (above >= 8 ? above : e.clientY + 12) + 'px';
}
function pollSpendSeries(force){
  if (spendSeriesBusy) return;
  if (!force && spendSeriesAt && Date.now() - spendSeriesAt < 30000) return;
  if (curTab !== 'tasks' && curTab !== 'lanes' && !task.id) return;
  spendSeriesBusy = true;
  fetch('/api/spend-series', { signal: AbortSignal.timeout(8000) })
    .then(function(r){ if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
    .then(function(j){
      if (!j || j.ok === false || !j.series) throw new Error('bad /api/spend-series payload');
      var m = {};
      for (var k in j.series) m[k.split('\u0000').join('|')] = j.series[k];
      spendSeries = m; spendSeriesAt = Date.now();
    })
    .catch(function(){}) // garnish — never an error surface
    .finally(function(){
      spendSeriesBusy = false;
      if (byId('kanban')) paintSparks(byId('kanban'));
      var db2 = byId('drawerBody');
      if (task.id && db2 && !byId('drawer').hidden) paintSparks(db2);
    });
}
function sparkSvg(points, w, h){
  var svg = document.createElementNS(SVGNS, 'svg');
  svg.setAttribute('width', w); svg.setAttribute('height', h);
  svg.setAttribute('viewBox', '0 0 ' + w + ' ' + h);
  var drawer = w > 180, slots = drawer ? 40 : 30;
  var first = Number(points[0][0]), last = Number(points[points.length - 1][0]);
  var slotMs = Math.max(180000, Math.ceil((last - first + 1) / (slots - 1) / 60000) * 60000);
  var start = first;
  var bins = {}, maxV = 0, i;
  for (i = 0; i < points.length; i++){
    var slot = Math.floor((Number(points[i][0]) - start) / slotMs);
    if (slot < 0 || slot >= slots) continue;
    var b = bins[slot] || (bins[slot] = [0, 0, 0]);
    b[0] += Number(points[i][1]) || 0;
    b[1] += Number(points[i][2]) || 0;
    b[2] += Number(points[i][3]) || 0;
  }
  for (var key in bins) maxV = Math.max(maxV, bins[key][0] + bins[key][1]);
  svg.setAttribute('role', 'img');
  svg.setAttribute('data-bin-min', String(slotMs / 60000));
  svg.setAttribute('aria-label', 'Fresh and cached input tokens from first request to latest, ' + (slotMs / 60000) + '-minute intervals');
  if (!maxV) return svg;
  var step = w / slots, barW = Math.max(1, Math.min(drawer ? 7 : 4, step - 1));
  for (i = 0; i < slots; i++){
    var at = start + i * slotMs, bucket = bins[i];
    if (!bucket) continue;
    var x = i * step + (step - barW) / 2;
    var used = 0;
    for (var part = 0; part < 2; part++){
      var val = bucket[part];
      if (val <= 0) continue;
      var bh = Math.max(0.5, val / maxV * (h - 2));
      var rect = document.createElementNS(SVGNS, 'rect');
      rect.setAttribute('x', x.toFixed(1));
      rect.setAttribute('y', Math.max(1, h - 1 - used - bh).toFixed(1));
      rect.setAttribute('width', barW.toFixed(1));
      rect.setAttribute('height', bh.toFixed(1));
      rect.setAttribute('class', part ? 'spark-cached' : 'spark-fresh');
      rect.setAttribute('data-at', String(at));
      rect.setAttribute('data-minutes', String(slotMs / 60000));
      rect.setAttribute('data-fresh', String(bucket[0]));
      rect.setAttribute('data-cached', String(bucket[1]));
      rect.setAttribute('data-out', String(bucket[2]));
      svg.appendChild(rect);
      used += bh;
    }
  }
  svg.addEventListener('pointermove', function(e){
    var bar = e.target;
    if (bar && bar.tagName && bar.tagName.toLowerCase() === 'rect') showSparkTip(e, bar);
    else hideSparkTip();
  });
  svg.addEventListener('pointerleave', hideSparkTip);
  return svg;
}
function paintSparks(root){
  var els = root.querySelectorAll('.kspark');
  for (var i = 0; i < els.length; i++){
    var el = els[i];
    var key = el.getAttribute('data-spark') || '';
    var pts = spendSeries[key] || null;
    var sig = pts ? pts.length + ':' + pts[pts.length - 1].join(':') + ':' + Math.floor(Date.now() / 60000) : '';
    if (el.getAttribute('data-ssig') === sig) continue;
    el.setAttribute('data-ssig', sig);
    var tip = byId('ksparkTip');
    if (tip && tip._bar && el.contains(tip._bar)) hideSparkTip();
    while (el.firstChild) el.removeChild(el.firstChild);
    var big = el.closest ? el.closest('.kspend-drawer') : null;
    var axis = el.parentElement.querySelector('.ksparkaxis');
    if (axis) axis.style.display = 'none';
    if (pts && pts.length){
      var chart = sparkSvg(pts, big ? 240 : 180, big ? 36 : 28);
      el.appendChild(chart);
      if (axis){
        axis.style.display = 'flex';
        axis.firstElementChild.textContent = new Date(pts[0][0]).toLocaleTimeString('da-DK', {hour:'2-digit', minute:'2-digit'});
        axis.lastElementChild.textContent = new Date(pts[pts.length - 1][0]).toLocaleTimeString('da-DK', {hour:'2-digit', minute:'2-digit'}) + ' · ' + chart.getAttribute('data-bin-min') + 'm/bin';
      }
    }
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
function pollTask(force){
  if (!task.id || task.busy) return;
  if (!force && task.okAt && Date.now() - task.okAt < 5000) return; // drawer refresh throttle
  task.busy = true;
  // the task's own project beats the global filter — 'all' must still resolve
  var qp = task.proj ? '?project=' + encodeURIComponent(task.proj) : projQuery();
  fetch('/api/task' + qp + (qp ? '&' : '?') + 'id=' + encodeURIComponent(task.id), { signal: AbortSignal.timeout(8000) })
    .then(function(r){ if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
    .then(function(j){
      if (!j || j.ok === false) throw new Error((j && j.error) || 'bad /api/task payload');
      if (!j.task || !Array.isArray(j.events)) throw new Error('bad /api/task payload');
      task.data = j; task.err = null; task.okAt = Date.now();
      pollExecutionTrace();
    })
    .catch(function(e){ task.err = String((e && e.message) || e); })
    .finally(function(){ task.busy = false; renderDrawer(); });
}
function pollExecutionTrace(){
  if (!task.id || task.executionBusy || (task.executionAt && Date.now() - task.executionAt < 30000)) return;
  var id = task.id, proj = task.proj || (task.data && task.data.task && task.data.task.project);
  if (!proj) return;
  var sameTask = function(){ return task.id === id && (task.proj || (task.data && task.data.task && task.data.task.project)) === proj; };
  task.executionBusy = true; task.executionAt = Date.now(); task.executionErr = null;
  fetch('/api/task/execution?project=' + encodeURIComponent(proj) + '&id=' + encodeURIComponent(id), { signal: AbortSignal.timeout(20000) })
    .then(function(r){ if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
    .then(function(j){ if (sameTask()) task.execution = j; })
    .catch(function(e){ if (sameTask()) task.executionErr = String(e && e.message || e); })
    .finally(function(){ if (sameTask()) { task.executionBusy = false; renderDrawer(); } });
}
function renderDrawer(){
  if (!task.id) return;
  var d = task.data;
  setText(byId('drawerTitle'), d ? d.task.id + ' — ' + String(d.task.title || '').slice(0, 70) : 'task ' + task.id);
  var body = byId('drawerBody');
  if (!d) {
    if (!task.err) return; // keep the loading row
    body.setAttribute('data-sig', '');
    errBanner(body, 'task unavailable — ' + String(task.err).slice(0, 120), function(){ task.err = null; pollTask(true); });
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
