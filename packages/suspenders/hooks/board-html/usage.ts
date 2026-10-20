// The board owns Usage navigation; the Lit panels continue to read the
// same #usage-data contract as the former standalone document.
export const USAGE = `
var usageKey = null;
var usageBusy = false;
var usageRequest = 0;
var usageSectionKey = '';
function usageParams(){
  var parsed = parseHashQuery(location.hash);
  var result = new URLSearchParams();
  if (parsed.tab !== 'usage') return result;
  ['days', 'weeks', 'team', 'dept', 'includeDemo'].forEach(function(key){
    if (parsed.params[key] !== undefined) result.set(key, parsed.params[key]);
  });
  return result;
}
function usageSection(){
  var name = parseHashQuery(location.hash).params.section || '';
  if (name === 'usage-hour') name = 'actors';
  if (['overview', 'actors', 'cache', 'sources', 'activity'].indexOf(name) < 0) return;
  if (usageSectionKey === location.hash) return;
  setTimeout(function(){
    var target = byId('usageBody').querySelector('#' + name);
    if (target) { usageSectionKey = location.hash; target.scrollIntoView({block: 'start'}); }
  }, 0);
}
function pollUsage(){
  if (curTab !== 'usage') return;
  var params = usageParams();
  var key = params.toString();
  if (usageKey === key) { usageSection(); return; }
  if (usageBusy) return;
  usageBusy = true;
  var request = ++usageRequest;
  var state = byId('usageState');
  state.hidden = false;
  state.textContent = 'loading usage...';
  fetch('/api/usage/view?' + key, {signal: AbortSignal.timeout(20000)})
    .then(function(response){ if (!response.ok) throw Error('HTTP ' + response.status); return response.json(); })
    .then(function(data){
      if (request !== usageRequest) return;
      byId('usage-data').textContent = JSON.stringify(data.payload);
      var host = byId('usageBody');
      host.replaceChildren(byId('usageTemplate').content.cloneNode(true));
      usageKey = key;
      state.hidden = true;
      usageSection();
    })
    .catch(function(error){
      if (request !== usageRequest) return;
      state.textContent = 'Usage could not load: ' + String(error.message || error);
    })
    .finally(function(){ usageBusy = false; if (curTab === 'usage' && key !== usageParams().toString()) pollUsage(); });
}
byId('usageBody').addEventListener('click', function(event){
  var anchor = event.composedPath().find(function(node){ return node && node.tagName === 'A'; });
  if (!anchor || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0) return;
  var url = new URL(anchor.href, location.href);
  if (url.origin !== location.origin) return;
  if (url.pathname === '/' && !url.hash) {
    event.preventDefault(); location.hash = 'decisions'; return;
  }
  if (url.pathname !== '/usage' && url.pathname !== '/') return;
  event.preventDefault();
  var params = url.pathname === '/usage' ? new URLSearchParams(url.search) : usageParams();
  if (url.hash) params.set('section', url.hash.slice(1));
  var next = 'usage' + (params.size ? '?' + params : '');
  if (location.hash === '#' + next) usageSection();
  else location.hash = next;
});
`;
