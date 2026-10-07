// hooks/board-html/renders.ts — conn/fleet/llm/claims/done/events renders (W157 client chunk).
// String.raw matches the original single-template semantics; bun's
// non-ASCII escaping in String.raw reproduces the served page bytes.
import {
	matchesHubScope,
	selectGovernorCompletions,
	selectGovernorLanes,
} from "./fleet-lane-view.ts";

export const RENDERS = `// --- 1: overall status + connection health (live / stale / error) ---
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
  el.title = observed ? 'Source: ' + observed.source + ' · target: ' + observed.target + ' · scope: ' + observed.scope + ' · observed: ' + new Date(observed.observedAt).toLocaleTimeString() + ' · expires: ' + new Date(observed.expiresAt).toLocaleTimeString() : 'Legacy feed without observation provenance';
  if (el.getAttribute('data-sig') !== sig) {
    el.setAttribute('data-sig', sig);
    el.innerHTML = '<span class="dot ' + cls + '"></span>' + esc(txt) + ' <span class="dim">| ' + esc(dec) + '</span>' +
      (dataErr ? ' <button class="retry" id="connRetry" type="button">retry</button>' : '');
    var rb = byId('connRetry');
    if (rb) rb.addEventListener('click', function(){ dataErr = null; pollData(); });
  }
}
// Current status is based on recent heartbeat evidence, not persistent state alone.
var selectGovernorLanes = ${selectGovernorLanes.toString()};
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
  if (relay && relay.nextRetryAt) relayText += ' · next retry ' + new Date(relay.nextRetryAt).toLocaleTimeString();
  if (relay && relay.lastError) relayText += ' · ' + relay.lastError;
  if (note) setText(note, relayText + ' ' + (snapshot ? 'Authenticated operator observations · origin and immediate downstream are separate axes. Unobserved lanes remain unknown; observations grant no work authority.' : 'No hub observation feed installed. Lane provenance is unknown.'));
  var body = byId('downstreamObservations');
  if (!body) return;
  var rows = (snapshot && snapshot.lanes || []).filter(function(o){ return o.expiresAt > Date.now() && scopedSource(o.laneId, o.project); });
  var fragment = document.createDocumentFragment();
  rows.slice(0, 100).forEach(function(o){
    var row = document.createElement('p'); row.className = 'mono';
    row.textContent = o.laneId + ' · origin ' + o.originHub + ' · via ' + o.peerHub + ' · ' + o.project + ' · observed ' + ago(msAgo(o.observedAt)) + ' · expires ' + new Date(o.expiresAt).toLocaleTimeString();
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
    var chip = document.createElement('span');
    chip.className = 'chip' + (s.state !== 'CLOSED' && s.state !== 'IDLE' && zombieFor(s.sid, zombies) ? ' zombie' : '');
    chip.title = s.sid;
    var observed = hubScope().observations.filter(function(o){ return o.laneId === s.sid && o.project === s.project && o.expiresAt > Date.now(); });
    chip.title += observed.length ? ' · ' + observed.map(function(o){ return 'origin ' + o.originHub + ' via ' + o.peerHub; }).join('; ') : ' · hub provenance unknown';
    var name = document.createElement('b');
    name.textContent = s.label || s.sid;
    chip.appendChild(name);
    var flagged = !!(needs && needs[s.sid] && needs[s.sid].length);
    chip.appendChild(document.createTextNode(' · ' + stateLabel(s.state, flagged) + ' · heartbeat ' + (ago(s.hbAgo) || 'unknown')));
    if (s.project) chip.appendChild(document.createTextNode(' · ' + s.project));
    if (s.model) {
      var badge = document.createElement('span');
      badge.className = 'lmodel' + (s.locality === 'local' ? ' loc' : '');
      badge.textContent = ' · ' + s.model + (s.locality ? ' (' + s.locality + ')' : '');
      chip.appendChild(badge);
    }
    fragment.appendChild(chip);
  }
  if (!lanes.length) {
    var empty = document.createElement('p');
    empty.className = 'dim';
    empty.textContent = 'No lanes with a heartbeat in the past hour.';
    fragment.appendChild(empty);
  }
  el.replaceChildren(fragment);
}
function renderFleetHistory(view, zombies, needs){
  var details = byId('fleetHistory');
  var maxPage = Math.max(0, Math.ceil(view.history.length / 50) - 1);
  fleetHistoryPage = Math.min(fleetHistoryPage, maxPage);
  setText(details.querySelector('summary'), view.history.length + ' older lanes · browse history');
  details.hidden = !view.history.length;
  if (!details.open) return;
  var start = fleetHistoryPage * 50;
  renderFleetLanes(byId('fleetHistoryLanes'), view.history.slice(start, start + 50), zombies, needs);
  setText(byId('fleetHistoryRange'), (start + 1) + '–' + Math.min(start + 50, view.history.length) + ' of ' + view.history.length);
  byId('fleetHistoryPrev').disabled = fleetHistoryPage === 0;
  byId('fleetHistoryNext').disabled = fleetHistoryPage >= maxPage;
}
function fleetElements(body){
  if (byId('fleetRecent')) return;
  var recent = document.createElement('div');
  recent.id = 'fleetRecent';
  var caption = document.createElement('p');
  caption.className = 'dim';
  caption.textContent = 'Current lanes first · heartbeat within 5 minutes. Recent lanes cover the past hour.';
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
  details.addEventListener('toggle', function(){ if (details.open) renderFleet(); });
  body.replaceChildren(caption, recent, details);
}
function renderFleet(){
  var d = lastData;
  if (!d) { setText(byId('fleetLine'), 'fleet: loading...'); return; }
  renderHubObservations(d);
  var view = selectGovernorLanes(d.sessions || [], sel.value, hubScope());
  var ss = view.current;
  var working = 0;
  for (var i = 0; i < ss.length; i++) if (ss[i].state === 'RUNNING') working++;
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
  if (sel.value !== 'all') { el.textContent = 'Model telemetry is fleet-wide; select all projects to view it.'; return; }
  if (!d.llm) { el.innerHTML = '<div class="dim">no llm telemetry in payload (older board build)</div>'; return; }
  var h = '';
  var u = d.llm.usage || [];
  if (!u.length) h += '<div class="dim">no llm.call events today — advise round-trips will appear here</div>';
  for (var i = 0; i < u.length; i++) {
    var m = u[i];
    var pct = m.budget ? Math.min(100, Math.round(m.tokens / m.budget * 100)) : null;
    h += '<div class="llmrow"><b>' + esc(m.model) + '</b> · ' + m.tokens + ' tok · ' + m.calls + ' call' + (m.calls === 1 ? '' : 's') + (m.budget ? ' · budget ' + m.budget + ' <span class="dim">(' + pct + '%)</span><div style="height:4px;background:var(--klh-edge);border-radius:2px;margin-top:2px"><div style="height:4px;width:' + pct + '%;background:var(--klh-ok-ink);border-radius:2px"></div></div>' : ' · <span class="dim">no llm.budget.' + esc(m.model) + ' fact set</span>') + '</div>';
  }
  var calls = d.llm.calls || [];
  if (calls.length) {
    h += '<div class="dim" style="margin-top:8px">recent calls:</div>';
    for (var j = 0; j < calls.length; j++) {
      var c = calls[j];
      h += '<div class="mono">' + esc(String(c.model)) + ' · ' + (c.error ? '<span style="color:var(--klh-danger-ink)">ERR ' + esc(String(c.error)) + '</span>' : c.tt + ' tok · ' + c.ms + 'ms') + ' · ' + new Date(c.ts).toLocaleTimeString() + '</div>';
    }
  }
  el.innerHTML = h;
}
function renderClaims(d){
  var fragment = document.createDocumentFragment();
  var cs = d.claims || [];
  for (var i = 0; i < cs.length; i++) {
    var x = cs[i];
    if (!scopedSource(x.sid, x.project)) continue;
    var owner = (d.labels || {})[x.sid] || String(x.sid || '').slice(0, 10);
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
}
function renderDone(d){
  var fragment = document.createDocumentFragment();
  var completions = selectGovernorCompletions(d.projects || [], sel.value, hubScope());
  for (var i = 0; i < completions.length; i++) {
    var dn = completions[i];
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
  var fragment = document.createDocumentFragment();
  var es = d.events || [];
  for (var j = es.length - 1; j >= 0; j--) {
    var e = es[j];
    if (!scopedSource(e.source, e.project)) continue;
    var kl = String(e.kind).toLowerCase();
    if (evFilter !== 'all' && kl.indexOf(evFilter) < 0) continue;
    var row = document.createElement('div'); row.className = 'r';
    var ts = document.createElement('span'); ts.className = 'ts'; ts.textContent = agoShort(e.tsAgo);
    var text = document.createElement('span');
    text.textContent = '#' + e.id + ' ' + e.kind + ' ' + String(e.source).slice(0, 12) + (e.target ? ' → ' + String(e.target).slice(0, 10) : '') + (e.note ? ' — ' + String(e.note).slice(0, 56) : '');
    row.appendChild(ts); row.appendChild(text); fragment.appendChild(row);
  }
  if (!fragment.childNodes.length) { var empty = document.createElement('div'); empty.className = 'r dim'; empty.textContent = '(no matching events in this scope)'; fragment.appendChild(empty); }
  byId('events').replaceChildren(fragment);
}
function setFilt(f){ evFilter = f; if (lastData) renderEvents(lastData); }
`;
