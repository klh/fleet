// hooks/board-html/tasks-owner.ts — owner identity + labels and the owner select render (W2269.1.3 decompose of tasks.ts;
// same page-global chunk scope — TASKS assembles from the purpose-named pieces).
export const TASKS_OWNER = String.raw`
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

`;
