// hooks/board-html/core-router.ts — the hash-router service (W2269.1.3 decompose of core.ts:
// #filter, W890 query-style tab hashes #<tab>?key=value, deep links, project scoping).
// String.raw keeps bun's non-ASCII escaping byte-identical to HEAD (W157).
// biome-ignore lint/complexity/noUselessStringRaw: byte-compat (W157)
export const CORE_ROUTER = String.raw`var feeds = globalThis.klhFeeds || (globalThis.klhFeeds = new FeedStore().share()); // one poller per browser: Web Lock leader, BroadcastChannel snapshots
// --- #filter=<text> deep-link (statusline worker indicators link here) ---
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
`;
