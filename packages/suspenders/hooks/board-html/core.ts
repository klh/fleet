// hooks/board-html/core.ts — assembly face: esc/sig/setNodes/stamp helpers the page shares.
// W2269.1.3 decompose: hash-router service → core-router.ts; feed-store embed + poller → core-feeds.ts.
import { CORE_FEEDS } from "./core-feeds.ts";
import { CORE_ROUTER } from "./core-router.ts";
import { byId } from "./board-dom.ts";
import { ago, agoShort, msAgo } from "./board-format.ts";
import { stampAges } from "./feed-ages.ts";

export const CORE =
	CORE_FEEDS +
	CORE_ROUTER +
	// biome-ignore lint/complexity/noUselessStringRaw: byte-compat (W157)
	String.raw`var byId = ${byId.toString()};
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
// the ONE age vocabulary (board-format.ts) — Lit components import the same
${ago.toString()}
${agoShort.toString()}
${msAgo.toString()}
// absolute stamps → ages on a 304 (feed-ages.ts), on the server clock: the
// skew is measured from the last 200 build stamp
${stampAges.toString()}
var feedSkew = 0;
function noteSkew(j){ if (j && typeof j.ts === 'number') feedSkew = Date.now() - j.ts; }
function restamp(j){ stampAges(j, Date.now() - feedSkew); }
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
function workTone(state){
  if (state === 'CLAIMED' || state === 'RUNNING') return 'working';
  if (state === 'WAITING' || state === 'BLOCKED' || state === 'PAUSED') return 'blocked';
  if (state === 'SHATTERED') return 'split';
  if (state === 'FAILED') return 'failed';
  if (state === 'DONE') return 'done';
  if (state === 'CANCELLED') return 'cancelled';
  return 'ready';
}
function taskPill(state){
  var s = String(state || '').toLowerCase();
  var tone = ' data-tone="' + workTone(state) + '"';
  if (state === 'WAITING') return '<span class="pill waiting"' + tone + ' title="External prerequisite; requires a verified wake">' + stLetter('waiting') + 'waiting</span>';
  if (state === 'SHATTERED') return '<span class="pill split"' + tone + ' title="Split into child work items; completes when required children finish">' + stLetter('split') + 'split</span>';
  if (state === 'CLAIMED' || state === 'RUNNING') return '<span class="pill run"' + tone + '>' + stLetter(s) + s + '</span>';
  if (state === 'DONE') return '<span class="pill done"' + tone + '>' + stLetter('done') + 'done</span>';
  if (state === 'CANCELLED') return '<span class="pill cancel"' + tone + '>' + stLetter('cancelled') + 'cancelled</span>';
  if (state === 'BLOCKED' || state === 'PAUSED') return '<span class="pill block"' + tone + '>' + stLetter(s) + s + '</span>';
  if (state === 'FAILED') return '<span class="pill fail"' + tone + '>' + stLetter('failed') + 'failed</span>';
  return '<span class="pill ready"' + tone + '>' + stLetter(s || '?') + (s || '?') + '</span>';
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
// Feeds own fetching (one in flight, adaptive cadence, scope-safe); the
// poll* names stay as forced kicks for the retry buttons and tab switches.
feeds.define('data', {
  url: function(){ return '/api/data'; },
  accept: function(j){ if (!j || typeof j.ts !== 'number' || !Array.isArray(j.projects)) throw new Error('bad /api/data payload'); },
  ok: function(j, changed){
    dataOkAt = Date.now(); dataErr = null;
    if (!changed) { if (lastData === j) { restamp(j); renderAll(); } return; }
    if (j.ts < lastDataTs) return;
    noteSkew(j); lastData = j; lastDataTs = j.ts;
    noteProjects(j.projects.map(function(p){ return p.project; }).concat((j.sessions || []).map(function(s){ return s.project; })));
    noteProjects(((j.laneObservations || {}).lanes || []).map(function(o){ return o.project; }));
    renderAll();
  },
  fail: function(e){ dataErr = e; renderAll(); }
});
function pollData(){ feeds.kick('data', true); }
feeds.define('dec', {
  url: function(){ return '/api/decisions' + projQuery(); },
  accept: function(j){ if (!j || typeof j.ts !== 'number' || !Array.isArray(j.decisions)) throw new Error('bad /api/decisions payload'); },
  ok: function(j, changed){
    decOkAt = Date.now(); decErr = null; decLoaded = true;
    if (!changed) { if (lastDec === j) { restamp(j); renderAll(); } return; }
    noteSkew(j); lastDec = j;
    noteProjects(j.projects);
    noteNew(j.decisions);
    renderAll();
  },
  fail: function(e){ decErr = e; renderAll(); }
});
function pollDec(){ feeds.kick('dec', true); }
// 1Hz render heartbeat: ages tick in place (sig-guarded, no fetch); due
// feeds fire from here only when their adaptive cadence says so.
function tick(){
  renderAll();
  feeds.kickDue(); // every feed (FEEDS + data/dec/hist) — each gates on its url()
}
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
`;
