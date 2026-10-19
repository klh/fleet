// hooks/board-html/activity.ts — activity feed (W157 client chunk).
// String.raw matches the original single-template semantics; bun's
// non-ASCII escaping in String.raw reproduces the served page bytes.
// biome-ignore lint/complexity/noUselessStringRaw: byte-compat (W157)
export const ACTIVITY = String.raw`// --- 5: activity feed (Activity tab, /api/activity, newest first) ---
function pollAct(){
  if (actBusy || curTab !== 'activity') return;
  actBusy = true;
  var scope = projQuery();
  fetch('/api/activity?limit=300' + (scope ? '&' + scope.slice(1) : ''), { signal: AbortSignal.timeout(8000) })
    .then(function(r){ if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
    .then(function(j){
      if (scope !== projQuery()) return;
      if (!j || j.ok === false || !Array.isArray(j.events)) throw new Error('bad /api/activity payload');
      actData = j; actOkAt = Date.now(); actErr = null; actLoaded = true;
      noteProjects(j.projects);
    })
    .catch(function(e){ if (scope === projQuery()) actErr = String((e && e.message) || e); })
    .finally(function(){ actBusy = false; renderAct(); if (scope !== projQuery()) pollAct(); });
}
function renderAct(){
  var errEl = byId('actErr');
  var body = byId('actBody');
  var hist = byId('actHist');
  if (!actLoaded && !actErr) {
    clearErr(errEl);
    sigSet(body, 'loading', '<div class="r"><span class="dim">loading activity...</span></div>');
    return;
  }
  if (actErr) {
    var when = actOkAt ? ago(Math.round((Date.now() - actOkAt) / 1000)) : 'never';
    errBanner(errEl, 'activity feed unavailable — last good ' + when, function(){ actErr = null; pollAct(); });
  } else {
    clearErr(errEl);
  }
  if (!actData) return;
  var ev = (actData.events || []).filter(function(e){ return scopedSource(e.source, e.project); });
  renderActHist(hist, ev);
  var recent = '', older = '', shown = 0;
  for (var i = 0; i < ev.length; i++) {
    var e = ev[i] || {};
    if (actDrill && (e.ts < actDrill.start || e.ts >= actDrill.end)) continue;
    var row = '<div class="r"><span class="ts">' + agoShort(msAgo(e.ts)) + '</span><span>';
    row += '<span class="akind">' + esc(String(e.kind || '?')) + '</span> <span class="mono">' + esc(String(e.source || '?').slice(0, 16)) + '</span>';
    if (e.target) row += ' -&gt; ' + esc(String(e.target).slice(0, 12));
    if (e.note) row += ' — ' + esc(String(e.note).slice(0, 80));
    if (e.sha) row += ' <span class="mono">@' + esc(String(e.sha).slice(0, 7)) + '</span>';
    row += '</span></div>';
    if (shown < 12) recent += row;
    else older += row;
    shown++;
  }
  var html = '<div class="activityhead">' + shown + (actDrill ? ' events in selected interval' : ' recent events') + ' · newest first' + (actDrill ? ' <button class="linkbtn" id="actClear">Show all</button>' : '') + '</div>' + recent;
  if (older) html += '<details class="activityolder"><summary>Older events (' + (shown - 12) + ')</summary>' + older + '</details>';
  if (!shown) html += '<div class="r"><span class="dim">No events in this interval.</span></div>';
  sigSet(body, String(actOkAt) + '|' + sel.value + '|' + hubOrigin + '|' + hubPeer + '|' + (actDrill ? actDrill.start : ''), html);
  var clear = byId('actClear');
  if (clear) clear.onclick = function(){ actDrill = null; renderAct(); };
}
function actKindGroup(kind){
  if (/landed|done|resolved|settled/i.test(kind)) return 'landed';
  if (/failed|blocked|alert|rogue/i.test(kind)) return 'failed';
  if (/decision|consult|answer/i.test(kind)) return 'decision';
  return 'other';
}
function renderActHist(el, ev){
  if (!el) return;
  if (!ev.length) { sigSet(el, 'empty', ''); return; }
  var last = Math.max(Date.now(), Number(ev[0].ts) || 0);
  var first = Math.min.apply(null, ev.map(function(e){ return Number(e.ts) || last; }));
  var step = Math.max(60000, Math.ceil((last - first) / (24 * 60000)) * 60000);
  var end = Math.ceil(last / step) * step;
  var start = end - 24 * step;
  var bins = Array.from({length:24}, function(){ return {landed:0, failed:0, decision:0, other:0}; });
  ev.forEach(function(e){
    var i = Math.floor((Number(e.ts) - start) / step);
    if (i >= 0 && i < bins.length) bins[i][actKindGroup(String(e.kind || ''))]++;
  });
  var max = Math.max(1, ...bins.map(function(b){ return b.landed + b.failed + b.decision + b.other; }));
  var fmt = function(t){ return new Date(t).toLocaleTimeString([], {hour:'2-digit', minute:'2-digit'}); };
  var html = '<div class="acthist-head"><span>Activity · ' + ev.length + (actData.events.length >= 300 ? ' latest events (limit 300)' : ' events') + '</span><span>' + Math.round(step / 60000) + ' min / bar</span></div>';
  html += '<div class="acthist-bars" role="group" aria-label="Activity timeline">';
  bins.forEach(function(b, i){
    var total = b.landed + b.failed + b.decision + b.other;
    var t = start + i * step;
    var label = fmt(t) + '–' + fmt(t + step) + ': ' + total + ' events, ' + b.landed + ' landed, ' + b.failed + ' failed, ' + b.decision + ' decisions';
    var selected = actDrill && actDrill.start === t;
    html += '<button type="button" class="acthist-bar' + (selected ? ' selected' : '') + '" data-start="' + t + '" data-end="' + (t + step) + '" aria-label="' + esc(label) + '" title="' + esc(label) + '"><span class="acthist-stack" style="height:' + Math.max(total ? 6 : 2, Math.round(total / max * 100)) + '%">';
    ['landed','failed','decision','other'].forEach(function(group){ if (b[group]) html += '<span class="acthist-' + group + '" style="flex:' + b[group] + '"></span>'; });
    html += '</span></button>';
  });
  html += '</div><div class="acthist-foot"><span>' + fmt(start) + '</span><span class="acthist-key"><i class="acthist-landed"></i> landed <i class="acthist-failed"></i> failed <i class="acthist-decision"></i> decision <i class="acthist-other"></i> other</span><span>' + fmt(end) + '</span></div>';
  sigSet(el, String(actOkAt) + '|' + sel.value + '|' + hubOrigin + '|' + hubPeer + '|' + (actDrill ? actDrill.start : ''), html);
  el.querySelectorAll('.acthist-bar').forEach(function(btn){
    btn.onclick = function(){ actDrill = {start:Number(btn.dataset.start), end:Number(btn.dataset.end)}; renderAct(); };
  });
}
`;
