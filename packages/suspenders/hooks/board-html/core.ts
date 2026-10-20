// hooks/board-html/core.ts — hash filter, esc/sig helpers, polling loop (W157 client chunk).
// String.raw matches the original single-template semantics; bun's
// non-ASCII escaping in String.raw reproduces the served page bytes.
// biome-ignore lint/complexity/noUselessStringRaw: byte-compat (W157)
export const CORE = String.raw`// --- #filter=<text> deep-link (statusline worker indicators link here) ---
var hashFilter = ''; // raw needle from the hash; '' = no filtering
var boardQuery = ''; // live search, independent of deep-link filters
function boardMatch(parts){
  if (!boardQuery) return true;
  var q = boardQuery.toLowerCase();
  for (var i = 0; i < parts.length; i++) {
    if (String(parts[i] == null ? '' : parts[i]).toLowerCase().indexOf(q) >= 0) return true;
  }
  return false;
}
function safeDecode(s){
  try { return decodeURIComponent(s); } catch (e2) { return s; }
}
// W890 query-style tab hashes: #<tab>?key=value&... — the grammar behind
// #lanes?w=<id> deep links. Legacy no-'?' hashes (#filter=...,
// #task=<id>&proj=<p>) never reach this parser.
function parseHashQuery(hash){
  var h = String(hash || '');
  var i = h.indexOf('?');
  if (i < 0) return { tab: h.replace(/^#/, ''), params: {} };
  var params = {};
  var pairs = h.slice(i + 1).split('&');
  for (var p = 0; p < pairs.length; p++) {
    var pair = pairs[p];
    if (!pair) continue;
    var eq = pair.indexOf('=');
    var k = safeDecode(eq < 0 ? pair : pair.slice(0, eq));
    if (!k) continue;
    var v = eq < 0 ? '' : safeDecode(pair.slice(eq + 1));
    if (params[k] === undefined) params[k] = v; // first occurrence wins
  }
  return { tab: safeDecode(h.slice(1, i)), params: params };
}
// query params this router owns; everything else warns loudly and is ignored
var HASH_PARAM_KEYS = { w: 1, task: 1, id: 1, project: 1, q: 1, filter: 1, proj: 1, days: 1, weeks: 1, team: 1, dept: 1, includeDemo: 1, hour: 1, section: 1 };
var pendingProj = ''; // ?project= seen before the scope <select> had its option
var pendingSelect = null; // ?w= card select waiting for its kanban card to render
function hashNeedle(){
  var m = (location.hash || '').match(/^#filter=([^&]*)/);
  if (m) return m[1] ? safeDecode(m[1]) : '';
  var p = parseHashQuery(location.hash || '').params;
  if (p.q !== undefined) return p.q;
  if (p.filter !== undefined) return p.filter;
  return '';
}
function hashMatch(parts){
  if (!hashFilter) return true;
  var f = hashFilter.toLowerCase();
  for (var i = 0; i < parts.length; i++) {
    if (String(parts[i] == null ? '' : parts[i]).toLowerCase().indexOf(f) >= 0) return true;
  }
  return false;
}
function applyHashFilter(){
  hashFilter = hashNeedle();
  var bar = byId('hashChipBar');
  if (bar) sigSet(bar, hashFilter, hashFilter ? '<span class="chip">filtered by <b>' + esc(hashFilter) + '</b> · <button type="button" class="hfclear">clear</button></span>' : '');
  renderTasks();
  renderKanban();
  renderDecisions();
}
// apply one query-style hash (#<tab>?k=v&...): switch tab, ?project= scope,
// ?w/task/id= item deep link, ?q/filter= needle (the caller's applyHashFilter
// reads it via hashNeedle). Unknown params warn loudly; the tab still switches.
function applyHashRoute(){
  var parsed = parseHashQuery(location.hash || '');
  var p = parsed.params;
  if (!Object.keys(p).length) return; // bare tab / legacy hash — legacy owners keep it
  var item = p.w !== undefined ? p.w : p.task !== undefined ? p.task : p.id;
  // an item deep link lands on lanes regardless of the named tab — skip the redundant switch
  if (parsed.tab && TABS[parsed.tab] && item === undefined) setTab(parsed.tab, true);
  else if (parsed.tab && item === undefined) console.warn('[board] unknown tab in hash: #' + parsed.tab);
  if (p.project !== undefined) applyHashProject(p.project); // project first — the drawer fetch scopes off sel.value
  if (item !== undefined) applyHashItem(item, p);
  var unknown = [];
  for (var k in p) if (!HASH_PARAM_KEYS[k] && unknown.indexOf(k) < 0) unknown.push(k);
  if (unknown.length) console.warn('[board] unknown hash params ignored: ' + unknown.join(', '));
}
function applyHashProject(v){
  var want = String(v || '');
  if (!want) { console.warn('[board] empty project param in hash'); return; }
  if (scopeProjectSelect(want)) return;
  pendingProj = want; // option list not loaded yet — noteProjects applies it later
}
function scopeProjectSelect(want){
  var opts = sel.options;
  for (var i = 0; i < opts.length; i++) {
    if (opts[i].value !== want && projShort(opts[i].value) !== want) continue;
    pendingProj = '';
    if (sel.value === opts[i].value) return true;
    sel.value = opts[i].value;
    sel.dispatchEvent(new Event('change'));
    return true;
  }
  return false;
}
// ?w=<id>: land on lanes, open the drawer (same openTask path as #task=), and
// mark the card (scroll into view + .ksel highlight) once the kanban renders it
function applyHashItem(v, p){
  var id = String(v || '');
  if (!id) { console.warn('[board] empty item id in hash'); return; }
  setTab('lanes', true); // item numbers link straight into the lanes view
  var proj = p.proj ? p.proj : null;
  openTask(id, proj, null);
  pendingSelect = { id: id, proj: proj, at: Date.now() };
  trySelectCard();
}
function trySelectCard(){
  if (!pendingSelect || curTab !== 'lanes') return;
  if (Date.now() - pendingSelect.at > 30000) { pendingSelect = null; return; }
  var kanban = byId('kanban');
  if (!kanban) return;
  var cards = kanban.querySelectorAll('.kcard');
  for (var i = 0; i < cards.length; i++) {
    if (cards[i].getAttribute('data-kid') !== pendingSelect.id) continue;
    if (pendingSelect.proj && cards[i].getAttribute('data-kproj') !== pendingSelect.proj) continue;
    // a full kanban rebuild (e.g. the executor dropdown arriving) wipes the
    // class — re-apply on every render until expiry; scroll exactly once
    cards[i].classList.add('ksel');
    if (!pendingSelect.applied) {
      pendingSelect.applied = true;
      cards[i].scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
    return;
  } // card not rendered yet — pendingSelect survives, the next renderKanban retries
}
function byId(id){ return document.getElementById(id); }
function esc(s){ return String(s == null ? '' : s).replace(/[&<>"']/g, function(c){ return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]; }); }
function setText(el, v){ if (el && el.textContent !== v) el.textContent = v; }
// W669.11: the last string sinks retired (UI law). Fragments parse
// out-of-line (DOMParser content never executes scripts) and move in as
// nodes; row fragments parse in table context so <tr> survives intact.
// W658.3 landed the sink for sigSet; W669.11 opens it to stragglers.
function setNodes(el, html){
  var rows = el.tagName === 'TBODY' || el.tagName === 'THEAD';
  var doc = new DOMParser().parseFromString(
    rows ? '<table><tbody>' + html + '</tbody></table>' : '<div>' + html + '</div>',
    'text/html');
  var root = rows ? doc.body.firstElementChild.firstElementChild : doc.body.firstElementChild;
  var nodes = [];
  while (root.firstChild) nodes.push(root.removeChild(root.firstChild));
  el.replaceChildren.apply(el, nodes);
}
function sigSet(el, sig, html){
  if (el.getAttribute('data-sig') === sig) return;
  el.setAttribute('data-sig', sig);
  setNodes(el, html);
}
// sig-guarded rebuild that keeps focus alive across row swaps (tasks table)
function sigSetKeep(el, sig, html, attr){
  var prev = el.contains(document.activeElement) && document.activeElement !== document.body ? document.activeElement : null;
  var pid = prev && prev.getAttribute ? prev.getAttribute(attr) : null;
  sigSet(el, sig, html);
  if (pid != null && !document.contains(prev)) {
    var nb = el.querySelector('[' + attr + '="' + pid + '"]');
    if (nb) nb.focus();
  }
}
function ago(s){
  if (s == null || s < 0) return '';
  if (s < 10) return 'just now';
  if (s < 60) return s + 's ago';
  if (s < 3600) { var m = Math.round(s / 60); return m + (m === 1 ? ' minute' : ' minutes') + ' ago'; }
  if (s < 86400) { var h = Math.round(s / 3600); return h + (h === 1 ? ' hour' : ' hours') + ' ago'; }
  var dd = Math.round(s / 86400); return dd + (dd === 1 ? ' day' : ' days') + ' ago';
}
function agoShort(s){
  if (s == null || s < 0) return '-';
  if (s < 60) return s + 's';
  if (s < 3600) return Math.round(s / 60) + 'm';
  if (s < 86400) return Math.round(s / 3600) + 'h';
  return Math.round(s / 86400) + 'd';
}
function msAgo(ts){ return ts != null ? Math.max(0, Math.round((Date.now() - ts) / 1000)) : null; }
// W891 — state letters: the displayed state's initial rides the pill/status
// word, colored by the klh semantic state tokens (F red, R blue, D green,
// Q gray) — hues resolve through vars, never literals.
var ST_HUES = {
  ready: 'info',
  waiting: 'accent',
  claimed: 'accent',
  running: 'accent',
  done: 'ok',
  failed: 'danger',
  blocked: 'danger',
  paused: 'danger',
  zombie: 'danger',
  'waiting for you': 'danger',
  working: 'accent',
  'rate-limited': 'accent'
};
function stateHue(label){
  return ST_HUES[String(label == null ? '' : label).toLowerCase()] || 'dim';
}
function stLetter(label){
  var s = String(label == null ? '' : label);
  return '<b class="stl ' + stateHue(s) + '">' + (s ? esc(s.charAt(0).toUpperCase()) : '?') + '</b>';
}
function taskPill(state){
  var s = String(state || '').toLowerCase();
  if (state === 'WAITING') return '<span class="pill waiting" title="External prerequisite; requires a verified wake">' + stLetter('waiting') + 'waiting</span>';
  if (state === 'SHATTERED') return '<span class="pill ready" title="Split into child work items; completes when required children finish">' + stLetter('split') + 'split</span>';
  if (state === 'CLAIMED' || state === 'RUNNING') return '<span class="pill run">' + stLetter(s) + s + '</span>';
  if (state === 'DONE') return '<span class="pill done">' + stLetter('done') + 'done</span>';
  if (state === 'CANCELLED') return '<span class="pill cancel">' + stLetter('cancelled') + 'cancelled</span>';
  if (state === 'BLOCKED' || state === 'PAUSED') return '<span class="pill block">' + stLetter(s) + s + '</span>';
  if (state === 'FAILED') return '<span class="pill block">' + stLetter('failed') + 'failed</span>';
  return '<span class="pill ready">' + stLetter(s || '?') + (s || '?') + '</span>';
}
function zombieFor(sid, zombies){
  for (var z = 0; z < zombies.length; z++) if (String(zombies[z].label).indexOf(String(sid).slice(0, 10)) === 0) return true;
  return false;
}
// named lane states — raw jargon never rendered as visible text
var STATES = { RUNNING: 'working', WAITING: 'waiting for you', PAUSED: 'paused', RATE_LIMITED: 'rate-limited', ZOMBIE: 'zombie', CLOSED: 'quiet', IDLE: 'quiet' };
function stateLabel(state, flagged){
  if (flagged) return 'waiting for you'; // pending decisions beat the raw state
  var raw = String(state == null ? '' : state).toUpperCase();
  return STATES[raw] || (raw ? raw.toLowerCase() : 'quiet');
}
// --- polling: single in-flight request per endpoint, 8s timeout, stale
// responses dropped by server-ts compare, last good kept on failure ---
function postJSON(url, body){
  return fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(8000) })
    .then(function(r){
      return r.json().catch(function(){ return {}; }).then(function(j){
        j = j || {};
        if (!r.ok && !j.error && !j.output) j.error = 'HTTP ' + r.status;
        return j;
      });
    });
}
function projQuery(){
  if (!sel.value || sel.value === 'all') return '';
  return '?project=' + encodeURIComponent(sel.value);
}
// merge every good response's 'projects' list into the global filter
function noteProjects(list){
  if (!Array.isArray(list)) return;
  var added = false;
  for (var i = 0; i < list.length; i++) {
    var p = String(list[i] || '');
    if (!p || knownProj[p]) continue;
    knownProj[p] = true;
    added = true;
  }
  if (!added) return;
  var keys = Object.keys(knownProj).sort();
  var cur = sel.value;
  while (sel.options.length > 1) sel.remove(1);
  for (var k = 0; k < keys.length; k++) {
    var o = document.createElement('option');
    o.value = keys[k];
    o.textContent = keys[k];
    sel.appendChild(o);
  }
  sel.value = cur === 'all' || knownProj[cur] ? cur : 'all';
  if (pendingProj) scopeProjectSelect(pendingProj); // W890: ?project= arrived before the option list did
}
function pollData(){
  if (dataBusy) return;
  dataBusy = true;
  fetch('/api/data', { signal: AbortSignal.timeout(8000) })
    .then(function(r){ if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
    .then(function(j){
      if (!j || typeof j.ts !== 'number' || !Array.isArray(j.projects)) throw new Error('bad /api/data payload');
      if (j.ts >= lastDataTs) { lastData = j; lastDataTs = j.ts; }
      noteProjects(j.projects.map(function(p){ return p.project; }).concat((j.sessions || []).map(function(s){ return s.project; })));
      noteProjects(((j.laneObservations || {}).lanes || []).map(function(o){ return o.project; }));
      dataOkAt = Date.now(); dataErr = null;
    })
    .catch(function(e){ dataErr = String((e && e.message) || e); })
    .finally(function(){ dataBusy = false; renderAll(); });
}
function pollDec(){
  if (decBusy) return;
  decBusy = true;
  var scope = projQuery();
  fetch('/api/decisions' + scope, { signal: AbortSignal.timeout(8000) })
    .then(function(r){ if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
    .then(function(j){
      if (scope !== projQuery()) return;
      if (!j || typeof j.ts !== 'number' || !Array.isArray(j.decisions)) throw new Error('bad /api/decisions payload');
      if (!lastDec || j.ts >= lastDec.ts) lastDec = j;
      decOkAt = Date.now(); decErr = null; decLoaded = true;
      noteProjects(j.projects);
      noteNew(j.decisions);
    })
    .catch(function(e){ if (scope === projQuery()) decErr = String((e && e.message) || e); })
    .finally(function(){ decBusy = false; renderAll(); if (scope !== projQuery()) pollDec(); });
}
function tick(){ renderConn(); pollData(); pollDec(); pollActiveTab(); pollSpendSeries(false); if (task.id) { pollTask(false); pollTail(); } }
function noteNew(list){
  var base = projBaseline || !decBaseline;
  projBaseline = false;
  for (var i = 0; i < list.length; i++) {
    var d = list[i];
    if (!decisionInProject(d)) continue;
    if (d.state && d.state !== 'OPEN') continue;
    if (base) { seen[d.id] = true; continue; } // baseline or fresh project filter, no toast storm
    if (seen[d.id]) continue;
    seen[d.id] = true;
    toast('new decision #' + d.id + ' — ' + String(d.question || '').slice(0, 90));
  }
  decBaseline = true;
}
function toast(msg){
  var t = document.createElement('div');
  t.className = 'toast';
  t.textContent = msg;
  byId('toasts').appendChild(t);
  setTimeout(function(){ t.remove(); }, 6000);
}
// sig-guarded inline error banner with a retry button; keeps last good data visible
function errBanner(el, text, onretry){
  if (el.getAttribute('data-sig') === text) return;
  el.setAttribute('data-sig', text);
  el.textContent = text + ' ';
  var rb = document.createElement('button');
  rb.className = 'retry';
  rb.type = 'button';
  rb.textContent = 'retry';
  rb.addEventListener('click', onretry);
  el.appendChild(rb);
}
function clearErr(el){
  if (el.getAttribute('data-sig') === '') return;
  el.setAttribute('data-sig', '');
  el.textContent = '';
}
`;
