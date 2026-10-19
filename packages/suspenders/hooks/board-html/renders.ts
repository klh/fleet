// hooks/board-html/renders.ts — conn/fleet/llm/claims/done/events renders (W157 client chunk).
// String.raw matches the original single-template semantics; bun's
// non-ASCII escaping in String.raw reproduces the served page bytes.
import {
	matchesHubScope,
	selectGovernorCompletions,
	selectGovernorLanes,
} from "./fleet-lane-view.ts";
import { mergeReadyWhy } from "../lib/lane-git.ts";

export const RENDERS = `// --- 1: overall status + connection health (live / stale / error) ---
function dualStamp(ms){ // W902: UTC Z + viewer-local twin — hub clocks drift
  if (!ms) return '';
  var d = new Date(ms); if (isNaN(d.getTime())) return String(ms);
  var p = function(n){ return (n < 10 ? '0' : '') + n; };
  var off = -d.getTimezoneOffset(), a = Math.abs(off), sg = off >= 0 ? '+' : '-';
  var loc = 'local ' + p(d.getHours()) + ':' + p(d.getMinutes()) + ', UTC' + sg + p(a / 60 | 0) + ':' + p(a % 60);
  return d.toISOString().replace(/\\.\\d{3}Z$/, 'Z') + ' (' + loc + ')';
}
function renderConn(){
  var observed = lastData && lastData.observation;
  var dAge = observed && typeof observed.observedAt === 'number' ? Math.max(0, Math.round((Date.now() - observed.observedAt) / 1000)) : dataOkAt ? Math.round((Date.now() - dataOkAt) / 1000) : -1;
  var evidenceStale = observed && (!Number.isFinite(observed.expiresAt) || observed.expiresAt <= Date.now() || observed.observedAt > Date.now() + 5000);
  var cAge = decOkAt ? Math.round((Date.now() - decOkAt) / 1000) : -1;
  var cls, txt;
  if (dataErr && !dataOkAt) { cls = 'err'; txt = 'connecting'; }
  else if (dataErr) { cls = 'err'; txt = 'error — last good ' + ago(dAge); }
  else if (evidenceStale || dAge >= 5) { cls = 'stale'; txt = 'stale snapshot — observed ' + ago(dAge); }
  else { cls = 'live'; txt = 'live'; }
  var dec;
  if (!decLoaded) dec = 'decisions loading';
  else if (decErr) dec = 'decisions unavailable';
  else dec = 'decisions checked ' + ago(cAge);
  var sig = cls + '|' + txt + '|' + dec;
  var el = byId('conn');
  el.title = observed ? 'Source: ' + observed.source + ' · target: ' + observed.target + ' · scope: ' + observed.scope + ' · observed: ' + dualStamp(observed.observedAt) + ' · expires: ' + dualStamp(observed.expiresAt) : 'Legacy feed without observation provenance';
  if (el.getAttribute('data-sig') !== sig) {
    el.setAttribute('data-sig', sig);
    setNodes(el, '<span class="dot ' + cls + '"></span>' + esc(txt) + ' <span class="dim">| ' + esc(dec) + '</span>' +
      (dataErr ? ' <button class="retry" id="connRetry" type="button">retry</button>' : ''));
    var rb = byId('connRetry');
    if (rb) rb.addEventListener('click', function(){ dataErr = null; pollData(); });
  }
}
// Current status is based on recent heartbeat evidence, not persistent state alone.
var selectGovernorLanes = ${selectGovernorLanes.toString()};
var mergeReadyWhy = ${mergeReadyWhy.toString()};
var selectGovernorCompletions = ${selectGovernorCompletions.toString()};
var matchesHubScope = ${matchesHubScope.toString()};
function hubScope(){
  return { origin: typeof hubOrigin === 'string' ? hubOrigin : 'all', peer: typeof hubPeer === 'string' ? hubPeer : 'all', now: Date.now(), observations: ((lastData || {}).laneObservations || {}).lanes || [] };
}
function scopedLane(sid, project){ return matchesHubScope(sid, project, hubScope()); }
function sourceProject(sid, project){
  if (project) return project;
  var session = ((lastData || {}).sessions || []).find(function(s){ return s.sid === sid; });
  return session ? session.project : null;
}
function scopedSource(sid, project){
  var p = sourceProject(sid, project);
  return (sel.value === 'all' || p === sel.value) && scopedLane(sid, p);
}
function govMatches(){
  var input = byId('govSearch');
  var q = input && input.value ? input.value.trim().toLowerCase() : '';
  if (!q) return true;
  for (var i = 0; i < arguments.length; i++) if (String(arguments[i] || '').toLowerCase().indexOf(q) >= 0) return true;
  return false;
}
function setGovPanel(id, count){
  var input = byId('govSearch'), target = byId(id);
  if (!input || !input.value.trim() || !target || !target.closest) return;
  var panel = target.closest('details.govpanel');
  if (panel) panel.open = count > 0;
}
function renderHubObservations(d){
  var snapshot = d.laneObservations;
  ['originHub', 'peerHub'].forEach(function(id){
    var control = byId(id);
    if (!control) return;
    var selected = control.value;
    var axis = id === 'originHub' ? 'originHub' : 'peerHub';
    var values = Array.from(new Set((snapshot && snapshot.lanes || []).filter(function(o){ return o.expiresAt > Date.now() && (sel.value === 'all' || o.project === sel.value); }).map(function(o){ return o[axis]; }))).sort();
    var signature = JSON.stringify(values);
    if (control.getAttribute('data-options') === signature) return;
    control.setAttribute('data-options', signature);
    while (control.options.length > 2) control.remove(2);
    values.forEach(function(value){ var option = document.createElement('option'); option.value = value; option.textContent = value; control.appendChild(option); });
    if (selected !== 'all' && selected !== 'unknown' && values.indexOf(selected) < 0) {
      var missing = document.createElement('option'); missing.value = selected; missing.textContent = selected + ' (no current observations)'; control.appendChild(missing);
    }
    control.value = selected;
  });
  var note = byId('hubScopeNote');
  var relay = d.observationRelay;
  var relayText = !relay || !relay.enabled ? 'Relay disabled: configure machine-level observation-relays.json.' : 'Relay ' + relay.localHub + ': ' + relay.sent + ' sent · ' + (relay.backlog || 0) + ' pending' + (relay.lastSuccessAt ? ' · last success ' + ago(msAgo(relay.lastSuccessAt)) : ' · awaiting first successful forward');
  if (relay && relay.nextRetryAt) relayText += ' · next retry ' + dualStamp(relay.nextRetryAt);
  if (relay && relay.lastError) relayText += ' · ' + relay.lastError;
  if (note) setText(note, relayText + ' ' + (snapshot ? 'Authenticated operator observations · origin and immediate downstream are separate axes. Unobserved lanes remain unknown; observations grant no work authority.' : 'No hub observation feed installed. Lane provenance is unknown.'));
  var body = byId('downstreamObservations');
  if (!body) return;
  var rows = (snapshot && snapshot.lanes || []).filter(function(o){ return o.expiresAt > Date.now() && scopedSource(o.laneId, o.project); });
  var fragment = document.createDocumentFragment();
  rows.slice(0, 100).forEach(function(o){
    var row = document.createElement('p'); row.className = 'mono';
    row.textContent = o.laneId + ' · origin ' + o.originHub + ' · via ' + o.peerHub + ' · ' + o.project + ' · observed ' + ago(msAgo(o.observedAt)) + ' · expires ' + dualStamp(o.expiresAt);
    fragment.appendChild(row);
  });
  if (!rows.length) { var empty = document.createElement('p'); empty.className = 'dim'; empty.textContent = 'No unexpired downstream observations in this scope.'; fragment.appendChild(empty); }
  if (rows.length > 100) { var bound = document.createElement('p'); bound.textContent = 'Showing 100 of ' + rows.length + ' observations. Narrow the filters.'; fragment.appendChild(bound); }
  body.replaceChildren(fragment);
}
var fleetHistoryPage = 0;
function renderFleetLanes(el, lanes, zombies, needs){
  var fragment = document.createDocumentFragment();
  for (var i = 0; i < lanes.length; i++) {
    var s = lanes[i];
    if (!govMatches(s.label, s.sid, s.project, s.model, s.state)) continue;
    var chip = document.createElement('div');
    chip.className = 'fleetrow' + (s.state !== 'CLOSED' && s.state !== 'IDLE' && zombieFor(s.sid, zombies) ? ' zombie' : '');
    chip.title = s.sid;
    var observed = hubScope().observations.filter(function(o){ return o.laneId === s.sid && o.project === s.project && o.expiresAt > Date.now(); });
    chip.title += observed.length ? ' · ' + observed.map(function(o){ return 'origin ' + o.originHub + ' via ' + o.peerHub; }).join('; ') : ' · hub provenance unknown';
    var name = document.createElement('b');
    name.textContent = s.label || s.sid;
    chip.appendChild(name);
    var flagged = !!(needs && needs[s.sid] && needs[s.sid].length);
    var claimed = s.state === 'RUNNING' || s.state === 'CLAIMED';
    // W378 fleet honesty: a claimed state with a non-alive verdict reads
    // 'stale'/'unverified', never 'working'.
    var label = stateLabel(s.state, flagged);
    if (!flagged && claimed && s.verdict && s.verdict !== 'alive') label = s.verdict === 'dead' ? 'stale' : 'unverified';
    var status = document.createElement('span'); status.className = 'fleetstate'; chip.appendChild(status);
    // W891 — the state letter rides the status word via the string sink
    setNodes(status, stLetter(label) + esc(label));
    var heartbeat = document.createElement('span'); heartbeat.className = 'dim'; heartbeat.textContent = ago(s.hbAgo) || 'unknown'; chip.appendChild(heartbeat);
    var project = document.createElement('span'); project.className = 'dim'; project.title = s.project || '';
    var path = s.project ? s.project.split('/').filter(Boolean) : [];
    project.textContent = path.length ? (path[path.length - 1] === '.git' ? path[path.length - 2] : path[path.length - 1]) : 'no project'; chip.appendChild(project);
    var model = document.createElement('span'); model.className = 'fleetmodel'; model.textContent = s.model || 'no model'; chip.appendChild(model);
    var gitObs = ((lastData || {}).laneGit || {})[s.sid];
    if (gitObs && gitObs.mergeReady != null) {
      var gwhy = mergeReadyWhy(gitObs);
      var gtext = gitObs.mergeReady === true ? 'merge-ready' : 'not merge-ready (' + gwhy.join(', ') + ')';
      chip.title += ' · ' + gtext;
      status.appendChild(document.createTextNode(gitObs.mergeReady === true ? ' / merge-ready' : ' / merge blocked'));
    }
    fragment.appendChild(chip);
  }
  if (!fragment.childNodes.length) {
    var empty = document.createElement('p');
    empty.className = 'dim';
    empty.textContent = 'No lanes match this scope.';
    fragment.appendChild(empty);
  }
  el.replaceChildren(fragment);
}
function renderFleetHistory(view, zombies, needs){
  var details = byId('fleetHistory');
  var history = view.history.filter(function(s){ return govMatches(s.label, s.sid, s.project, s.model, s.state); });
  var maxPage = Math.max(0, Math.ceil(history.length / 50) - 1);
  fleetHistoryPage = Math.min(fleetHistoryPage, maxPage);
  setText(details.querySelector('summary'), history.length + ' older lanes / browse history');
  details.hidden = !history.length;
  if (!details.open) return;
  var start = fleetHistoryPage * 50;
  renderFleetLanes(byId('fleetHistoryLanes'), history.slice(start, start + 50), zombies, needs);
  setText(byId('fleetHistoryRange'), (start + 1) + '–' + Math.min(start + 50, history.length) + ' of ' + history.length);
  var total = (lastData || {}).sessionsTotal || view.history.length;
  setText(byId('fleetHistoryNote'), total > view.history.length ? 'Oldest ' + (total - view.history.length) + ' not served — the board caps history at ' + view.history.length + ' lanes per feed.' : '');
  byId('fleetHistoryPrev').disabled = fleetHistoryPage === 0;
  byId('fleetHistoryNext').disabled = fleetHistoryPage >= maxPage;
}
function fleetElements(body){
  if (byId('fleetRecent')) return;
  var recent = document.createElement('div');
  recent.id = 'fleetRecent';
  var caption = document.createElement('p');
  caption.className = 'dim';
  caption.textContent = 'Current and recent lanes · heartbeat evidence from the past hour';
  var columns = document.createElement('div'); columns.className = 'fleetcolumns';
  ['Lane', 'State', 'Heartbeat', 'Project', 'Model'].forEach(function(label){ var cell = document.createElement('span'); cell.textContent = label; columns.appendChild(cell); });
  var details = document.createElement('details');
  details.id = 'fleetHistory';
  details.appendChild(document.createElement('summary'));
  var historical = document.createElement('div');
  historical.id = 'fleetHistoryLanes';
  details.appendChild(historical);
  var controls = document.createElement('div');
  ['Prev', 'Next'].forEach(function(direction){
    var button = document.createElement('button');
    button.type = 'button';
    button.id = 'fleetHistory' + direction;
    button.textContent = direction === 'Prev' ? 'Previous 50' : 'Next 50';
    button.addEventListener('click', function(){ fleetHistoryPage += direction === 'Prev' ? -1 : 1; renderFleet(); });
    controls.appendChild(button);
  });
  var range = document.createElement('span');
  range.id = 'fleetHistoryRange';
  range.className = 'dim';
  controls.appendChild(range);
  details.appendChild(controls);
  var note = document.createElement('p');
  note.id = 'fleetHistoryNote';
  note.className = 'dim';
  details.appendChild(note);
  details.addEventListener('toggle', function(){ if (details.open) renderFleet(); });
  body.replaceChildren(caption, columns, recent, details);
}
function renderFleet(){
  var d = lastData;
  if (!d) { setText(byId('fleetLine'), 'fleet: loading...'); return; }
  renderHubObservations(d);
  var view = selectGovernorLanes(d.sessions || [], sel.value, hubScope());
  var ss = view.current;
  var working = 0;
  // W378 fleet honesty: only rows the shared verdict calls alive count as
  // working — a stale RUNNING row never paints a running marker again.
  for (var i = 0; i < ss.length; i++) if (ss[i].state === 'RUNNING' && ss[i].live === true) working++;
  var zombies = d.zombies || [];
  var zN = view.recent.filter(function(s){ return s.state !== 'CLOSED' && s.state !== 'IDLE' && zombieFor(s.sid, zombies); }).length;
  var blocked = 0;
  var proj = d.projects || [];
  for (var p = 0; p < proj.length; p++) if (sel.value === 'all' || proj[p].project === sel.value) blocked += (proj[p].gated || []).filter(function(item){ return scopedLane(item.owner, proj[p].project); }).length;
  var waiting = openDecs().filter(function(decision){ return scopedSource(decision.asked_by || decision.target, decision.project); }).length;
  var line = 'fleet: ' + working + ' working · ' + waiting + ' waiting on you · ' + blocked + ' blocked' +
    ' · ' + view.recent.length + ' recent lanes' + (zN ? ' · ' + zN + ' recently flagged' : '');
  var ck = d.consults;
  if (sel.value === 'all' && hubScope().origin === 'all' && hubScope().peer === 'all' && ck && (ck.human || ck.kbSolutions)) {
    line += ' · consults: ' + ck.open + ' open, ' + (ck.human + ck.kb) + ' answered' +
      (ck.kbSolutions ? ' · kb ' + ck.kbSolutions + ' solutions/' + ck.kbHits + ' hits' : '');
  }
  var el = byId('fleetLine');
  setText(el, line);
  setText(byId('stamp'), (d.observation ? d.observation.kind + ' snapshot · observed ' : 'updated ') + ago(Math.max(0, Math.round((Date.now() - (d.observation ? d.observation.observedAt : d.ts)) / 1000))));
  byId('blockedn').textContent = blocked ? blocked + ' blocked' : '';
  var body = byId('fleetBody');
  if (body.style.display === 'none') return; // collapsed: skip chip rebuild
  fleetElements(body);
  renderFleetLanes(byId('fleetRecent'), view.recent, zombies, d.needs || {});
  renderFleetHistory(view, zombies, d.needs || {});
}
// --- W28 LLM telemetry (Governor tab): per-model token sums vs budgets + routing log ---
function renderLlm(d){
  var el = byId('llmview');
  if (!d.llm) { setNodes(el, '<div class="dim">no llm telemetry in payload (older board build)</div>'); return; }
  var h = '', matched = 0;
  var u = d.llm.usage || [];
  if (!u.length) h += '<div class="dim">no llm.call events today — advise round-trips will appear here</div>';
  for (var i = 0; i < u.length; i++) {
    var m = u[i];
    if (!govMatches(m.model)) continue;
    matched++;
    var pct = m.budget ? Math.min(100, Math.round(m.tokens / m.budget * 100)) : null;
    h += '<div class="llmrow"><b>' + esc(m.model) + '</b> · ' + (Number.isFinite(m.tokens) ? m.tokens + ' reported tok' : 'token usage unavailable') + ' · ' + m.calls + ' call' + (m.calls === 1 ? '' : 's') + (m.budget ? ' · budget ' + m.budget + ' <span class="dim">(' + pct + '%)</span><div style="height:4px;background:var(--klh-edge);border-radius:2px;margin-top:2px"><div style="height:4px;width:' + pct + '%;background:var(--klh-ok-ink);border-radius:2px"></div></div>' : ' · <span class="dim">no budget set</span>') + '</div>';
  }
  var calls = d.llm.calls || [];
  if (calls.length) {
    h += '<div class="dim" style="margin-top:8px">recent calls:</div>';
    for (var j = 0; j < calls.length; j++) {
      var c = calls[j];
      if (!govMatches(c.model, c.error)) continue;
      matched++;
      h += '<div class="mono">' + esc(String(c.model)) + ' · ' + (c.error ? '<span style="color:var(--klh-danger-ink)">ERR ' + esc(String(c.error)) + '</span>' : (Number.isFinite(c.tt) ? c.tt + ' reported tok' : 'token usage unavailable') + ' · ' + c.ms + 'ms') + ' · ' + dualStamp(c.ts) + '</div>';
    }
  }
  setNodes(el, h);
  setGovPanel('llmview', matched);
}
function renderClaims(d){
  var fragment = document.createDocumentFragment();
  var matched = 0;
  var cs = d.claims || [];
  for (var i = 0; i < cs.length; i++) {
    var x = cs[i];
    if (!scopedSource(x.sid, x.project)) continue;
    var owner = (d.labels || {})[x.sid] || String(x.sid || '').slice(0, 10);
    if (!govMatches(x.sid, x.project, x.scope, owner, x.intent)) continue;
    matched++;
    var wait = x.waiters != null ? 'waiting ' + String(x.waiters) : '';
    if (!wait && x.intent) wait = String(x.intent).slice(0, 44);
    var lease = x.lease != null ? String(x.lease) : 'held ' + ago(x.tsAgo);
    var row = document.createElement('div'); row.className = 'r' + (x.hot ? ' hot' : '');
    var resource = document.createElement('span'); resource.className = 'mono'; resource.textContent = x.scope || '?';
    row.appendChild(resource);
    row.appendChild(document.createTextNode(' → ' + owner + (wait ? ' → ' + wait : '') + ' → lease: ' + lease));
    fragment.appendChild(row);
  }
  if (!fragment.childNodes.length) { var empty = document.createElement('div'); empty.className = 'r dim'; empty.textContent = '(no claims in this scope)'; fragment.appendChild(empty); }
  byId('claims').replaceChildren(fragment);
  setGovPanel('claims', matched);
}
function renderFacts(d){
  var fs = d.facts || [];
  var h = '', matched = 0;
  for (var i = 0; i < fs.length; i++) {
    var f = fs[i];
    if (!govMatches(f.key, f.value, f.trust && f.trust.detail)) continue;
    matched++;
    var t = f.trust;
    var parts = [];
    if (t) {
      if (t.rating) parts.push(esc(t.rating));
      if (t.evidence) parts.push('ev ' + esc(t.evidence));
      if (t.researched) parts.push('researched ' + esc(t.researched));
    }
    var marker = parts.length ? ' [<span class="dim">' + parts.join(' · ') + '</span>]' : '';
    var body = esc(String((t && t.detail) ? t.detail : f.value).slice(0, 90));
    h += '<div class="r"><span class="ts">' + agoShort(f.tsAgo) + '</span><span>' + esc(f.key) + marker + ' — ' + body + '</span></div>';
  }
  if (!h) h = '<div class="r dim">(no lesson.*/finding.* facts yet)</div>';
  setNodes(byId('facts'), h);
  setGovPanel('facts', matched);
}
function renderDone(d){
  var fragment = document.createDocumentFragment();
  var matched = 0;
  var completions = selectGovernorCompletions(d.projects || [], sel.value, hubScope());
  for (var i = 0; i < completions.length; i++) {
    var dn = completions[i];
    if (!govMatches(dn.id, dn.title, dn.project)) continue;
    matched++;
    var row = document.createElement('div');
    row.className = 'r';
    row.title = dn.project + ' · ' + dn.title;
    var ts = document.createElement('span');
    ts.className = 'ts';
    ts.textContent = dn.updatedAgo >= 0 ? agoShort(dn.updatedAgo) : '-';
    var title = document.createElement('span');
    var id = document.createElement('b');
    id.className = 'mono';
    id.textContent = dn.id;
    title.appendChild(id);
    title.appendChild(document.createTextNode(' ' + String(dn.title).slice(0, 60)));
    row.appendChild(ts);
    row.appendChild(title);
    fragment.appendChild(row);
  }
  if (!completions.length) {
    var empty = document.createElement('div');
    empty.className = 'r dim';
    empty.textContent = '(none yet)';
    fragment.appendChild(empty);
  }
  byId('done').replaceChildren(fragment);
  setGovPanel('done', matched);
}
function renderEvents(d){
  var filts = ['all','landed','blocked','need','checkpoint','alert','answer'];
  var buttons = document.createDocumentFragment();
  for (var f = 0; f < filts.length; f++) {
    var button = document.createElement('button'); button.type = 'button';
    button.className = evFilter === filts[f] ? 'on' : '';
    button.textContent = filts[f];
    button.setAttribute('aria-pressed', String(evFilter === filts[f]));
    button.addEventListener('click', (function(filter){ return function(){ setFilt(filter); }; })(filts[f]));
    buttons.appendChild(button);
  }
  byId('filters').replaceChildren(buttons);
  var fragment = document.createDocumentFragment(), matched = 0;
  var es = d.events || [];
  for (var j = es.length - 1; j >= 0; j--) {
    var e = es[j];
    if (!scopedSource(e.source, e.project)) continue;
    if (!govMatches(e.kind, e.source, e.target, e.note, e.project)) continue;
    var kl = String(e.kind).toLowerCase();
    if (evFilter !== 'all' && kl.indexOf(evFilter) < 0) continue;
    matched++;
    var row = document.createElement('div'); row.className = 'r';
    var ts = document.createElement('span'); ts.className = 'ts'; ts.textContent = agoShort(e.tsAgo);
    var text = document.createElement('span');
    text.textContent = '#' + e.id + ' ' + e.kind + ' ' + String(e.source).slice(0, 12) + (e.target ? ' → ' + String(e.target).slice(0, 10) : '') + (e.note ? ' — ' + String(e.note).slice(0, 56) : '');
    row.appendChild(ts); row.appendChild(text); fragment.appendChild(row);
  }
  if (!fragment.childNodes.length) { var empty = document.createElement('div'); empty.className = 'r dim'; empty.textContent = '(no matching events in this scope)'; fragment.appendChild(empty); }
  byId('events').replaceChildren(fragment);
  setGovPanel('events', matched);
}
function setFilt(f){ evFilter = f; if (lastData) renderEvents(lastData); }
`;
