// hooks/board-html/tasks-spend.ts — spend-series garnish: /api/spend-series poll, sparklines, attempt timelines (W2269.1.3 decompose of tasks.ts;
// same page-global chunk scope — TASKS assembles from the purpose-named pieces).
export const TASKS_SPEND = String.raw`
var SVGNS = 'http://www.w3.org/2000/svg';
// --- card sparklines: per-item request spend over time painted
// as stacked bars — fresh = accent, cached = ok. Data rides
// /api/spend-series (30s poll, silent-fail garnish); the .kspark placeholders
// emitted by spendStripHtml get painted here and in the drawer. DOM-safe key:
// esc(project)+'|'+esc(id) (NUL is unusable in attributes).
var spendSeries = {}, spendSeriesAt = 0, spendSeriesBusy = false;
// W1188 attempt view: per-card current-attempt timelines from the same
// /api/spend-series poll (j.attempts), toggled per browser (default OFF —
// the truthful full-history spend chart stays the card's default).
var attemptData = {}, attemptView = false;
try { attemptView = localStorage.getItem('sb.attemptView') === '1'; } catch (e) {}
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
    var time = dualStamp(at);
    tip.textContent = time + ' · ' + minutes + ' min\nFresh input  ' + fresh.toLocaleString('en-US') + '\nCached input  ' + cached.toLocaleString('en-US') + '\nOutput  ' + out.toLocaleString('en-US');
    tip._bar = bar;
  }
  tip.hidden = false;
  var left = Math.min(e.clientX + 10, window.innerWidth - tip.offsetWidth - 8);
  var above = e.clientY - tip.offsetHeight - 10;
  tip.style.left = Math.max(8, left) + 'px';
  tip.style.top = (above >= 8 ? above : e.clientY + 12) + 'px';
}
function pollSpendSeries(force){ feeds.kick('spend', !!force); }
// W1203: the window derives from the MEASURED track, never a fixed bin count
// — bins = floor(track / SPARK_STEP_PX) at the token-design cell, the bin
// duration = SPARK_MIN_BIN_MS (the design bin: 6px <-> 3 minutes), and the
// window = bins x D end-pinned at the newest point, so wider cards show MORE
// history, the last bar hugs the track's right edge (no dead gap), and data
// shorter than the window left-aligns (empty bins draw no bars).
var SPARK_STEP_PX = 6, SPARK_BAR_CARD_PX = 4, SPARK_BAR_DRAWER_PX = 5, SPARK_MIN_BIN_MS = 180000;
function sparkSvg(points, w, h, barPx){
  var svg = document.createElementNS(SVGNS, 'svg');
  svg.setAttribute('width', w); svg.setAttribute('height', h);
  svg.setAttribute('viewBox', '0 0 ' + w + ' ' + h);
  var count = Math.floor(w / SPARK_STEP_PX);
  if (count < 1) return svg; // track narrower than one bin — totals line only
  var first = Number(points[0][0]), last = Number(points[points.length - 1][0]);
  var slotMs = SPARK_MIN_BIN_MS; // the design bin — 6px cell, 3 minutes
  var start = Math.max(first, last - count * slotMs); // end-pinned on dense data; short data left-aligns
  var bins = {}, maxV = 0, i;
  for (i = 0; i < points.length; i++){
    var slot = Math.floor((Number(points[i][0]) - start) / slotMs);
    if (slot > count - 1) slot = count - 1; // the newest point rides the last bin — never dropped
    if (slot < 0) continue; // pre-window points drop — never pile into the first bin
    var b = bins[slot] || (bins[slot] = [0, 0, 0]);
    b[0] += Number(points[i][1]) || 0;
    b[1] += Number(points[i][2]) || 0;
    b[2] += Number(points[i][3]) || 0;
  }
  for (var key in bins) maxV = Math.max(maxV, bins[key][0] + bins[key][1]);
  svg.setAttribute('role', 'img');
  svg.setAttribute('data-bin-min', String(slotMs / 60000));
  svg.setAttribute('data-window-end', String(start + count * slotMs));
  svg.setAttribute('aria-label', 'Fresh and cached input tokens in ' + (slotMs / 60000) + '-minute bins across the measured track');
  if (!maxV) return svg;
  var step = w / count, barW = barPx || SPARK_BAR_CARD_PX;
  for (i = 0; i < count; i++){
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
// W1203: width-derived windows repaint on resize — the two paint roots are
// observed; the data+width sig makes every other RO fire a cheap no-op.
var sparkRO = null;
function watchSparkWidth(root){
  if (!root || typeof ResizeObserver === 'undefined') return;
  if (!sparkRO) sparkRO = new ResizeObserver(function(entries){
    for (var e = 0; e < entries.length; e++) paintSparks(entries[e].target);
  });
  sparkRO.observe(root);
}
function paintSparks(root){
  watchSparkWidth(root);
  var els = root.querySelectorAll('.kspark');
  for (var i = 0; i < els.length; i++){
    var el = els[i];
    var key = el.getAttribute('data-spark') || '';
    var pts = spendSeries[key] || null;
    var sig = pts ? pts.length + ':' + pts[pts.length - 1].join(':') + ':' + Math.floor(Date.now() / 60000) + ':' + el.clientWidth : '';
    if (el.getAttribute('data-ssig') === sig) continue;
    el.setAttribute('data-ssig', sig);
    var tip = byId('ksparkTip');
    if (tip && tip._bar && el.contains(tip._bar)) hideSparkTip();
    while (el.firstChild) el.removeChild(el.firstChild);
    var big = el.closest ? el.closest('.kspend-drawer') : null;
    var axis = el.parentElement.querySelector('.ksparkaxis');
    if (axis) axis.style.display = 'none';
    var w = el.clientWidth; // the measured track (W1203) — the plot fills the card
    if (!pts || !pts.length || w < SPARK_STEP_PX) continue; // totals line only
    var chart = sparkSvg(pts, w, big ? 36 : 28, big ? SPARK_BAR_DRAWER_PX : SPARK_BAR_CARD_PX);
    el.appendChild(chart);
    if (axis){
      axis.style.display = 'flex';
      axis.firstElementChild.textContent = dualShort(pts[0][0]);
      axis.lastElementChild.textContent = dualShort(Number(chart.getAttribute('data-window-end'))) + ' · ' + chart.getAttribute('data-bin-min') + 'm/bin';
    }
  }
  paintAttempts(root);
}
// W1188: the attempt-view half of paintSparks — paints the .kattempt hosts
// emitted by spendStripHtml. Sig-guarded like the sparks; placeholder text
// when the item has no claim window overlapping the common window.
function paintAttempts(root){
  if (!attemptView) return;
  var els = root.querySelectorAll('.kattempt');
  for (var i = 0; i < els.length; i++){
    var el = els[i];
    var key = el.getAttribute('data-attempt') || '';
    var a = attemptData[key] || null;
    var sig = a ? JSON.stringify(a) : '';
    if (el.getAttribute('data-asig') === sig) continue;
    el.setAttribute('data-asig', sig);
    while (el.firstChild) el.removeChild(el.firstChild);
    el.appendChild(a ? attemptSvg(a) : document.createTextNode('no attempt in window'));
  }
}
// W1188: numeric-only SVG string parsed via DOMParser (the gate-compliant
// DOM channel); <title> children carry the exact segment bounds and the
// exact ISO commit timestamps of the artifact milestones.
function segTitle(g){
  return esc(g.kind) + ' · ' + Math.round((g.end - g.start) / 60000) + ' min · ' + esc(new Date(g.start).toISOString()) + ' → ' + esc(new Date(g.end).toISOString());
}
function attemptSvg(a){
  var w = 180, h = 24;
  var span = Math.max(1, a.windowEnd - a.windowStart);
  var fx = function(t){ var x = (t - a.windowStart) / span * w; return Math.max(0, Math.min(w, x)); };
  var s = '<svg xmlns="http://www.w3.org/2000/svg" width="180" height="24" role="img" aria-label="Current attempt: fixed 90-minute window, 3-minute bins; queue, firstbyte, tool, pause, unknown segments plus commit milestones">';
  return finishAttemptSvg(s, fx, a);
}
function finishAttemptSvg(s, fx, a){
  var segs = a.attempt.segments || [];
  for (var i = 0; i < segs.length; i++){
    var g = segs[i];
    var x0 = fx(g.start), x1 = Math.max(x0 + 1, fx(g.end));
    s += '<rect class="at-' + esc(g.kind) + '" x="' + x0.toFixed(1) + '" y="7" width="' + (x1 - x0).toFixed(1) + '" height="10" rx="2"><title>' + segTitle(g) + '</title></rect>';
  }
  var ms = a.milestones || [];
  for (var m = 0; m < ms.length; m++){
    var t0 = ms[m];
    var mx = fx(t0.ts);
    s += '<path class="at-ms" d="M ' + mx.toFixed(1) + ',7 l 3.5,5 l -3.5,5 l -3.5,-5 Z"><title>' + esc(t0.stage) + ' · ' + esc(new Date(t0.ts).toISOString()) + ' · ' + esc(t0.commit) + '</title></path>';
  }
  s += '</svg>';
  var doc = new DOMParser().parseFromString(s, 'image/svg+xml');
  if (!doc || doc.getElementsByTagName('parsererror').length) return document.createTextNode('');
  return doc.documentElement;
}
`;
