// hooks/board-html/setup.ts — setup checklist (W157 client chunk).
// String.raw matches the original single-template semantics; bun's
// non-ASCII escaping in String.raw reproduces the served page bytes.
// biome-ignore lint/complexity/noUselessStringRaw: byte-compat (W157)
export const SETUP = String.raw`// --- 6: setup checklist (Setup tab, /api/setup) ---
function pollSetup(){
  if (setupBusy) return;
  setupBusy = true;
  fetch('/api/setup', { signal: AbortSignal.timeout(8000) })
    .then(function(r){ if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
    .then(function(j){
      if (!j || j.ok === false || !Array.isArray(j.checks)) throw new Error('bad /api/setup payload');
      setupData = j; setupOkAt = Date.now(); setupErr = null; setupLoaded = true;
    })
    .catch(function(e){ setupErr = String((e && e.message) || e); })
    .finally(function(){ setupBusy = false; renderSetup(); });
}
// W858.7.21: checks group by what they verify — this machine's wiring
// (files, plists, settings) vs network probes. REMOTE_CHECKS pins the
// minority; unmapped ids default to local (never hidden, worst case a
// future remote check shows under local until the map grows).
var REMOTE_CHECKS = { 'llm': 1, 'hubs': 1 };
function checkCard(c){
  var detail = String(c.detail || '');
  var detailHtml = detail.startsWith('/') || detail.indexOf('.generation-') >= 0
    ? '<details class="sdetail"><summary>Technical details</summary><code>' + esc(detail) + '</code></details>'
    : '<div class="sdetail dim">' + esc(detail) + '</div>';
  return '<div class="card scard"><div class="shead"><span class="sok ' + (c.ok ? 'ok' : 'fail') + '">' + (c.ok ? 'ok' : 'fail') + '</span> <b>' + esc(c.label || c.id || '?') + '</b></div>' +
    detailHtml +
    (c.fix ? '<div class="sfix"><code>' + esc(String(c.fix)) + '</code> <button type="button" class="copyfix" data-fix="' + esc(String(c.fix)) + '">copy</button></div>' : '') +
    '</div>';
}
function groupHead(title, n){
  return '<h3 class="sgroup">' + esc(title) + ' <span class="dim">(' + n + ')</span></h3>';
}
function renderSetup(){
  var errEl = byId('setupErr');
  var body = byId('setupBody');
  if (!setupLoaded && !setupErr) {
    clearErr(errEl);
    sigSet(body, 'loading', '<div class="state dim">loading setup checks...</div>');
    return;
  }
  if (setupErr) {
    var when = setupOkAt ? ago(Math.round((Date.now() - setupOkAt) / 1000)) : 'never';
    errBanner(errEl, 'setup checks unavailable — last good ' + when, function(){ setupErr = null; pollSetup(); });
  } else {
    clearErr(errEl);
  }
  if (!setupData) return;
  var cs = setupData.checks || [];
  var failures = cs.filter(function(c){ return !c.ok; }).length;
  setText(byId('setupSummary'), failures ? failures + ' checks need attention / ' + cs.length + ' total' : cs.length + ' checks passing');
  var local = [];
  var remote = [];
  for (var i = 0; i < cs.length; i++) {
    var c = cs[i] || {};
    (REMOTE_CHECKS[c.id] ? remote : local).push(checkCard(c));
  }
  var html = '';
  if (local.length) html += groupHead('Local wiring', local.length) + local.join('');
  if (remote.length) html += groupHead('Remote reachability', remote.length) + remote.join('');
  if (!html) html = '<div class="state dim">(no checks returned)</div>';
  sigSet(body, String(setupOkAt), html);
}
`;
