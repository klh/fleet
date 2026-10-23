// Vendored from the Lit monorepo (lit, lit-html, lit-element, @lit/reactive-element) — BSD-3-Clause License (https://github.com/lit/lit); bundled offline.
var a=(t)=>new Date(t).toISOString().replace(/\.\d{3}Z$/,"Z"),g=(t)=>{let e=new Date(t),n=(c)=>String(c).padStart(2,"0"),r=-e.getTimezoneOffset(),u=r>=0?"+":"-",s=Math.abs(r);return`${e.getFullYear()}-${n(e.getMonth()+1)}-${n(e.getDate())}T${n(e.getHours())}:${n(e.getMinutes())}:${n(e.getSeconds())}${u}${n(Math.floor(s/60))}:${n(s%60)}`},o=(t)=>`${a(t)} (${g(t)})`,i=(t)=>`${a(t).slice(5)} (${g(t).slice(11,16)} local)`;
export{o,i};
