// hooks/board-html/history.ts — decision history (W157 client chunk).
// String.raw matches the original single-template semantics; bun's
// non-ASCII escaping in String.raw reproduces the served page bytes.
// biome-ignore lint/complexity/noUselessStringRaw: byte-compat (W157)
export const HISTORY = String.raw`// --- 3: decision history (collapsed under OPEN, /api/decisions&history=1) ---
feeds.define('hist', {
  url: function(){ if (!histOpen || curTab !== 'decisions') return null; var q = projQuery(); return '/api/decisions' + q + (q ? '&' : '?') + 'history=1'; },
  accept: function(j){ if (!j || j.ok === false || !Array.isArray(j.decisions)) throw new Error('bad /api/decisions payload'); },
  ok: function(j, changed){ histOkAt = Date.now(); histErr = null; histLoaded = true; if (!changed) return; histData = j; noteProjects(j.projects); renderHist(); },
  fail: function(e){ histErr = e; renderHist(); }
});
function pollHist(){ feeds.kick('hist', true); }
function renderHist(){
  var st = byId('histState');
  var errEl = byId('histErr');
  var body = byId('histBody');
  if (!histOpen) { setText(st, ''); errEl.text = ''; return; }
  var rows = [];
  if (histData) {
    var ds = histData.decisions || [];
    for (var i = 0; i < ds.length; i++) if (decisionInProject(ds[i]) && ds[i].state && ds[i].state !== 'OPEN') rows.push(ds[i]);
  }
  if (!histLoaded && !histErr) { setText(st, 'loading history...'); errEl.text = ''; return; }
  if (histErr) {
    var when = histOkAt ? ago(Math.round((Date.now() - histOkAt) / 1000)) : 'never';
    errEl.text = 'history unavailable — last good ' + when;
    setText(st, rows.length ? rows.length + ' archived · stale' : 'unavailable');
  } else {
    errEl.text = '';
    setText(st, rows.length ? rows.length + ' archived' : '(no archived decisions)');
  }
  if (!rows.length) { sigSet(body, 'empty', ''); return; }
  var html = '';
  for (var r = 0; r < rows.length; r++) {
    var d = rows[r];
    var age = ago(msAgo(d.answered_ts || d.ack_ts || d.created_ts));
    html += '<div class="hrow"><span class="pill hst">' + esc(String(d.state).toLowerCase()) + '</span>' +
      '<span><span class="hq">' + esc(String(d.question || '(no question text)').slice(0, 140)) + '</span>' +
      (d.answer_note ? '<span class="hans">' + esc(String(d.answer_note).slice(0, 200)) + '</span>' : '') +
      '</span><span class="hage dim">' + age + '</span></div>';
  }
  sigSet(body, String(histOkAt), html); // rebuild per good poll; ages stay fresh
}
`;
