// Vendored from the Lit monorepo (lit, lit-html, lit-element, @lit/reactive-element) — BSD-3-Clause License (https://github.com/lit/lit); bundled offline.
function m(n){if(n==null||n<0)return"";if(n<10)return"just now";if(n<60)return`${n}s ago`;if(n<3600){let r=Math.round(n/60);return`${r}${r===1?" minute":" minutes"} ago`}if(n<86400){let r=Math.round(n/3600);return`${r}${r===1?" hour":" hours"} ago`}let u=Math.round(n/86400);return`${u}${u===1?" day":" days"} ago`}function b(n){return n!=null?Math.max(0,Math.round((Date.now()-n)/1000)):null}
export{m,b};
