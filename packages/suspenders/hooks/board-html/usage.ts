// The board owns Usage navigation; the Lit panels continue to read the
// same #usage-data contract as the former standalone document.
export const USAGE = `
var usageKey = null; // the params of the payload now in #usage-data
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
// the view is the store's manual 'usage' feed (FEEDS): fetched only when
// the hash params change; a change mid-flight discards the stale view
function usageUrl(){ return curTab === 'usage' ? '/api/usage/view?' + usageParams().toString() : null; }
function pollUsage(){
  if (curTab !== 'usage') return;
  if (usageKey === usageParams().toString()) { usageSection(); return; }
  var state = byId('usageState');
  state.hidden = false;
  state.textContent = 'loading usage...';
  feeds.kick('usage', true);
}
function usageLanded(data){
  byId('usage-data').textContent = JSON.stringify(data.payload);
  byId('usageBody').replaceChildren(byId('usageTemplate').content.cloneNode(true));
  usageKey = usageParams().toString();
  byId('usageState').hidden = true;
  usageSection();
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
