var W=globalThis,J=W.ShadowRoot&&(W.ShadyCSS===void 0||W.ShadyCSS.nativeShadow)&&"adoptedStyleSheets"in Document.prototype&&"replace"in CSSStyleSheet.prototype,G=Symbol(),he=new WeakMap;class Q{constructor(e,t,s){if(this._$cssResult$=!0,s!==G)throw Error("CSSResult is not constructable. Use `unsafeCSS` or `css` instead.");this.cssText=e,this._strings=t}get styleSheet(){let e=this._styleSheet,t=this._strings;if(J&&e===void 0){let s=t!==void 0&&t.length===1;if(s)e=he.get(t);if(e===void 0){if((this._styleSheet=e=new CSSStyleSheet).replaceSync(this.cssText),s)he.set(t,e)}}return e}toString(){return this.cssText}}var Be=(e)=>{if(e._$cssResult$===!0)return e.cssText;else if(typeof e==="number")return e;else throw Error(`Value passed to 'css' function must be a 'css' function result: ${e}. Use 'unsafeCSS' to pass non-literal values, but take care to ensure page security.`)},We=(e)=>new Q(typeof e==="string"?e:String(e),void 0,G),j=(e,...t)=>{let s=e.length===1?e[0]:t.reduce((i,n,r)=>i+Be(n)+e[r+1],e[0]);return new Q(s,e,G)},ue=(e,t)=>{if(J)e.adoptedStyleSheets=t.map((s)=>s instanceof CSSStyleSheet?s:s.styleSheet);else for(let s of t){let i=document.createElement("style"),n=W.litNonce;if(n!==void 0)i.setAttribute("nonce",n);i.textContent=s.cssText,e.appendChild(i)}},je=(e)=>{let t="";for(let s of e.cssRules)t+=s.cssText;return We(t)},Z=J?(e)=>e:(e)=>e instanceof CSSStyleSheet?je(e):e;var{is:qe,defineProperty:Fe,getOwnPropertyDescriptor:me,getOwnPropertyNames:Ye,getOwnPropertySymbols:Ke,getPrototypeOf:fe}=Object,Xe=!1,f=globalThis;if(Xe)f.customElements??=customElements;var _=!0,b,_e=f.trustedTypes,Je=_e?_e.emptyScript:"",ye=_?f.reactiveElementPolyfillSupportDevMode:f.reactiveElementPolyfillSupport;if(_)f.litIssuedWarnings??=new Set,b=(e,t)=>{if(t+=` See https://lit.dev/msg/${e} for more information.`,!f.litIssuedWarnings.has(t)&&!f.litIssuedWarnings.has(e))console.warn(t),f.litIssuedWarnings.add(t)},queueMicrotask(()=>{if(b("dev-mode","Lit is in dev mode. Not recommended for production!"),f.ShadyDOM?.inUse&&ye===void 0)b("polyfill-support-missing","Shadow DOM is being polyfilled via `ShadyDOM` but the `polyfill-support` module has not been loaded.")});var Ge=_?(e)=>{if(!f.emitLitDebugLogEvents)return;f.dispatchEvent(new CustomEvent("lit-debug",{detail:e}))}:void 0,D=(e,t)=>e,ee={toAttribute(e,t){switch(t){case Boolean:e=e?Je:null;break;case Object:case Array:e=e==null?e:JSON.stringify(e);break}return e},fromAttribute(e,t){let s=e;switch(t){case Boolean:s=e!==null;break;case Number:s=e===null?null:Number(e);break;case Object:case Array:try{s=JSON.parse(e)}catch(i){s=null}break}return s}},be=(e,t)=>!qe(e,t),ge={attribute:!0,type:String,converter:ee,reflect:!1,useDefault:!1,hasChanged:be};Symbol.metadata??=Symbol("metadata");f.litPropertyMetadata??=new WeakMap;class g extends HTMLElement{static addInitializer(e){this.__prepare(),(this._initializers??=[]).push(e)}static get observedAttributes(){return this.finalize(),this.__attributeToPropertyMap&&[...this.__attributeToPropertyMap.keys()]}static createProperty(e,t=ge){if(t.state)t.attribute=!1;if(this.__prepare(),this.prototype.hasOwnProperty(e))t=Object.create(t),t.wrapped=!0;if(this.elementProperties.set(e,t),!t.noAccessor){let s=_?Symbol.for(`${String(e)} (@property() cache)`):Symbol(),i=this.getPropertyDescriptor(e,s,t);if(i!==void 0)Fe(this.prototype,e,i)}}static getPropertyDescriptor(e,t,s){let{get:i,set:n}=me(this.prototype,e)??{get(){return this[t]},set(r){this[t]=r}};if(_&&i==null){if("value"in(me(this.prototype,e)??{}))throw Error(`Field ${JSON.stringify(String(e))} on ${this.name} was declared as a reactive property but it's actually declared as a value on the prototype. Usually this is due to using @property or @state on a method.`);b("reactive-property-without-getter",`Field ${JSON.stringify(String(e))} on ${this.name} was declared as a reactive property but it does not have a getter. This will be an error in a future version of Lit.`)}return{get:i,set(r){let o=i?.call(this);n?.call(this,r),this.requestUpdate(e,o,s)},configurable:!0,enumerable:!0}}static getPropertyOptions(e){return this.elementProperties.get(e)??ge}static __prepare(){if(this.hasOwnProperty(D("elementProperties",this)))return;let e=fe(this);if(e.finalize(),e._initializers!==void 0)this._initializers=[...e._initializers];this.elementProperties=new Map(e.elementProperties)}static finalize(){if(this.hasOwnProperty(D("finalized",this)))return;if(this.finalized=!0,this.__prepare(),this.hasOwnProperty(D("properties",this))){let t=this.properties,s=[...Ye(t),...Ke(t)];for(let i of s)this.createProperty(i,t[i])}let e=this[Symbol.metadata];if(e!==null){let t=litPropertyMetadata.get(e);if(t!==void 0)for(let[s,i]of t)this.elementProperties.set(s,i)}this.__attributeToPropertyMap=new Map;for(let[t,s]of this.elementProperties){let i=this.__attributeNameForProperty(t,s);if(i!==void 0)this.__attributeToPropertyMap.set(i,t)}if(this.elementStyles=this.finalizeStyles(this.styles),_){if(this.hasOwnProperty("createProperty"))b("no-override-create-property","Overriding ReactiveElement.createProperty() is deprecated. The override will not be called with standard decorators");if(this.hasOwnProperty("getPropertyDescriptor"))b("no-override-get-property-descriptor","Overriding ReactiveElement.getPropertyDescriptor() is deprecated. The override will not be called with standard decorators")}}static finalizeStyles(e){let t=[];if(Array.isArray(e)){let s=new Set(e.flat(1/0).reverse());for(let i of s)t.unshift(Z(i))}else if(e!==void 0)t.push(Z(e));return t}static __attributeNameForProperty(e,t){let s=t.attribute;return s===!1?void 0:typeof s==="string"?s:typeof e==="string"?e.toLowerCase():void 0}constructor(){super();this.__instanceProperties=void 0,this.isUpdatePending=!1,this.hasUpdated=!1,this.__reflectingProperty=null,this.__initialize()}__initialize(){this.__updatePromise=new Promise((e)=>this.enableUpdating=e),this._$changedProperties=new Map,this.__saveInstanceProperties(),this.requestUpdate(),this.constructor._initializers?.forEach((e)=>e(this))}addController(e){if((this.__controllers??=new Set).add(e),this.renderRoot!==void 0&&this.isConnected)e.hostConnected?.()}removeController(e){this.__controllers?.delete(e)}__saveInstanceProperties(){let e=new Map,t=this.constructor.elementProperties;for(let s of t.keys())if(this.hasOwnProperty(s))e.set(s,this[s]),delete this[s];if(e.size>0)this.__instanceProperties=e}createRenderRoot(){let e=this.shadowRoot??this.attachShadow(this.constructor.shadowRootOptions);return ue(e,this.constructor.elementStyles),e}connectedCallback(){this.renderRoot??=this.createRenderRoot(),this.enableUpdating(!0),this.__controllers?.forEach((e)=>e.hostConnected?.())}enableUpdating(e){}disconnectedCallback(){this.__controllers?.forEach((e)=>e.hostDisconnected?.())}attributeChangedCallback(e,t,s){this._$attributeToProperty(e,s)}__propertyToAttribute(e,t){let i=this.constructor.elementProperties.get(e),n=this.constructor.__attributeNameForProperty(e,i);if(n!==void 0&&i.reflect===!0){let o=(i.converter?.toAttribute!==void 0?i.converter:ee).toAttribute(t,i.type);if(_&&this.constructor.enabledWarnings.includes("migration")&&o===void 0)b("undefined-attribute-value",`The attribute value for the ${e} property is undefined on element ${this.localName}. The attribute will be removed, but in the previous version of \`ReactiveElement\`, the attribute would not have changed.`);if(this.__reflectingProperty=e,o==null)this.removeAttribute(n);else this.setAttribute(n,o);this.__reflectingProperty=null}}_$attributeToProperty(e,t){let s=this.constructor,i=s.__attributeToPropertyMap.get(e);if(i!==void 0&&this.__reflectingProperty!==i){let n=s.getPropertyOptions(i),r=typeof n.converter==="function"?{fromAttribute:n.converter}:n.converter?.fromAttribute!==void 0?n.converter:ee;this.__reflectingProperty=i;let o=r.fromAttribute(t,n.type);this[i]=o??this.__defaultValues?.get(i)??o,this.__reflectingProperty=null}}requestUpdate(e,t,s,i=!1,n){if(e!==void 0){if(_&&e instanceof Event)b("","The requestUpdate() method was called with an Event as the property name. This is probably a mistake caused by binding this.requestUpdate as an event listener. Instead bind a function that will call it with no arguments: () => this.requestUpdate()");let r=this.constructor;if(i===!1)n=this[e];if(s??=r.getPropertyOptions(e),(s.hasChanged??be)(n,t)||s.useDefault&&s.reflect&&n===this.__defaultValues?.get(e)&&!this.hasAttribute(r.__attributeNameForProperty(e,s)))this._$changeProperty(e,t,s);else return}if(this.isUpdatePending===!1)this.__updatePromise=this.__enqueueUpdate()}_$changeProperty(e,t,{useDefault:s,reflect:i,wrapped:n},r){if(s&&!(this.__defaultValues??=new Map).has(e)){if(this.__defaultValues.set(e,r??t??this[e]),n!==!0||r!==void 0)return}if(!this._$changedProperties.has(e)){if(!this.hasUpdated&&!s)t=void 0;this._$changedProperties.set(e,t)}if(i===!0&&this.__reflectingProperty!==e)(this.__reflectingProperties??=new Set).add(e)}async __enqueueUpdate(){this.isUpdatePending=!0;try{await this.__updatePromise}catch(t){Promise.reject(t)}let e=this.scheduleUpdate();if(e!=null)await e;return!this.isUpdatePending}scheduleUpdate(){let e=this.performUpdate();if(_&&this.constructor.enabledWarnings.includes("async-perform-update")&&typeof e?.then==="function")b("async-perform-update",`Element ${this.localName} returned a Promise from performUpdate(). This behavior is deprecated and will be removed in a future version of ReactiveElement.`);return e}performUpdate(){if(!this.isUpdatePending)return;if(Ge?.({kind:"update"}),!this.hasUpdated){if(this.renderRoot??=this.createRenderRoot(),_){let n=[...this.constructor.elementProperties.keys()].filter((r)=>this.hasOwnProperty(r)&&(r in fe(this)));if(n.length)throw Error(`The following properties on element ${this.localName} will not trigger updates as expected because they are set using class fields: ${n.join(", ")}. Native class fields and some compiled output will overwrite accessors used for detecting changes. See https://lit.dev/msg/class-field-shadowing for more information.`)}if(this.__instanceProperties){for(let[i,n]of this.__instanceProperties)this[i]=n;this.__instanceProperties=void 0}let s=this.constructor.elementProperties;if(s.size>0)for(let[i,n]of s){let{wrapped:r}=n,o=this[i];if(r===!0&&!this._$changedProperties.has(i)&&o!==void 0)this._$changeProperty(i,void 0,n,o)}}let e=!1,t=this._$changedProperties;try{if(e=this.shouldUpdate(t),e)this.willUpdate(t),this.__controllers?.forEach((s)=>s.hostUpdate?.()),this.update(t);else this.__markUpdated()}catch(s){throw e=!1,this.__markUpdated(),s}if(e)this._$didUpdate(t)}willUpdate(e){}_$didUpdate(e){if(this.__controllers?.forEach((t)=>t.hostUpdated?.()),!this.hasUpdated)this.hasUpdated=!0,this.firstUpdated(e);if(this.updated(e),_&&this.isUpdatePending&&this.constructor.enabledWarnings.includes("change-in-update"))b("change-in-update",`Element ${this.localName} scheduled an update (generally because a property was set) after an update completed, causing a new update to be scheduled. This is inefficient and should be avoided unless the next update can only be scheduled as a side effect of the previous update.`)}__markUpdated(){this._$changedProperties=new Map,this.isUpdatePending=!1}get updateComplete(){return this.getUpdateComplete()}getUpdateComplete(){return this.__updatePromise}shouldUpdate(e){return!0}update(e){this.__reflectingProperties&&=this.__reflectingProperties.forEach((t)=>this.__propertyToAttribute(t,this[t])),this.__markUpdated()}updated(e){}firstUpdated(e){}}g.elementStyles=[];g.shadowRootOptions={mode:"open"};g[D("elementProperties",g)]=new Map;g[D("finalized",g)]=new Map;ye?.({ReactiveElement:g});if(_){g.enabledWarnings=["change-in-update","async-perform-update"];let e=function(t){if(!t.hasOwnProperty(D("enabledWarnings",t)))t.enabledWarnings=t.enabledWarnings.slice()};g.enableWarning=function(t){if(e(this),!this.enabledWarnings.includes(t))this.enabledWarnings.push(t)},g.disableWarning=function(t){e(this);let s=this.enabledWarnings.indexOf(t);if(s>=0)this.enabledWarnings.splice(s,1)}}(f.reactiveElementVersions??=[]).push("2.1.2");if(_&&f.reactiveElementVersions.length>1)queueMicrotask(()=>{b("multiple-versions","Multiple versions of Lit loaded. Loading multiple versions is not recommended.")});var y=globalThis,a=(e)=>{if(!y.emitLitDebugLogEvents)return;y.dispatchEvent(new CustomEvent("lit-debug",{detail:e}))},Qe=0,U;y.litIssuedWarnings??=new Set,U=(e,t)=>{if(t+=e?` See https://lit.dev/msg/${e} for more information.`:"",!y.litIssuedWarnings.has(t)&&!y.litIssuedWarnings.has(e))console.warn(t),y.litIssuedWarnings.add(t)},queueMicrotask(()=>{U("dev-mode","Lit is in dev mode. Not recommended for production!")});var E=y.ShadyDOM?.inUse&&y.ShadyDOM?.noPatch===!0?y.ShadyDOM.wrap:(e)=>e,q=y.trustedTypes,$e=q?q.createPolicy("lit-html",{createHTML:(e)=>e}):void 0,Ze=(e)=>e,X=(e,t,s)=>Ze,et=(e)=>{if(A!==X)throw Error("Attempted to overwrite existing lit-html security policy. setSanitizeDOMValueFactory should be called at most once.");A=e},tt=()=>{A=X},re=(e,t,s)=>A(e,t,s),Pe="$lit$",v=`lit$${Math.random().toFixed(9).slice(2)}$`,ke="?"+v,st=`<${ke}>`,N=document,I=()=>N.createComment(""),L=(e)=>e===null||typeof e!="object"&&typeof e!="function",oe=Array.isArray,it=(e)=>oe(e)||typeof e?.[Symbol.iterator]==="function",te=`[ 	
\f\r]`,nt=`[^ 	
\f\r"'\`<>=]`,rt=`[^\\s"'>=/]`,R=/<(?:(!--|\/[^a-zA-Z])|(\/?[a-zA-Z][^>\s]*)|(\/?$))/g,Ee=1,se=2,ot=3,Se=/-->/g,we=/>/g,P=new RegExp(`>|${te}(?:(${rt}+)(${te}*=${te}*(?:${nt}|("|')|))|$)`,"g"),at=0,ve=1,lt=2,xe=3,ie=/'/g,ne=/"/g,Oe=/^(?:script|style|textarea|title)$/i,dt=1,F=2,Y=3,ae=1,K=2,ct=3,pt=4,ht=5,le=6,ut=7,de=(e)=>(t,...s)=>{if(t.some((i)=>i===void 0))console.warn(`Some template strings are undefined.
This is probably caused by illegal octal escape sequences.`);if(s.some((i)=>i?._$litStatic$))U("",`Static values 'literal' or 'unsafeStatic' cannot be used as values to non-static templates.
Please use the static 'html' tag function. See https://lit.dev/docs/templates/expressions/#static-expressions`);return{["_$litType$"]:e,strings:t,values:s}},h=de(dt),wt=de(F),vt=de(Y),C=Symbol.for("lit-noChange"),d=Symbol.for("lit-nothing"),Te=new WeakMap,O=N.createTreeWalker(N,129),A=X;function Ne(e,t){if(!oe(e)||!e.hasOwnProperty("raw")){let s="invalid template strings array";throw s=`
          Internal Error: expected template strings to be an array
          with a 'raw' field. Faking a template strings array by
          calling html or svg like an ordinary function is effectively
          the same as calling unsafeHtml and can lead to major security
          issues, e.g. opening your code up to XSS attacks.
          If you're using the html or svg tagged template functions normally
          and still seeing this error, please file a bug at
          https://github.com/lit/lit/issues/new?template=bug_report.md
          and include information about your build tooling, if any.
        `.trim().replace(/\n */g,`
`),Error(s)}return $e!==void 0?$e.createHTML(t):t}var mt=(e,t)=>{let s=e.length-1,i=[],n=t===F?"<svg>":t===Y?"<math>":"",r,o=R;for(let p=0;p<s;p++){let w=e[p],c=-1,m,T=0,u;while(T<w.length){if(o.lastIndex=T,u=o.exec(w),u===null)break;if(T=o.lastIndex,o===R){if(u[Ee]==="!--")o=Se;else if(u[Ee]!==void 0)o=we;else if(u[se]!==void 0){if(Oe.test(u[se]))r=new RegExp(`</${u[se]}`,"g");o=P}else if(u[ot]!==void 0)throw Error("Bindings in tag names are not supported. Please use static templates instead. See https://lit.dev/docs/templates/expressions/#static-expressions")}else if(o===P)if(u[at]===">")o=r??R,c=-1;else if(u[ve]===void 0)c=-2;else c=o.lastIndex-u[lt].length,m=u[ve],o=u[xe]===void 0?P:u[xe]==='"'?ne:ie;else if(o===ne||o===ie)o=P;else if(o===Se||o===we)o=R;else o=P,r=void 0}console.assert(c===-1||o===P||o===ie||o===ne,"unexpected parse state B");let k=o===P&&e[p+1].startsWith("/>")?" ":"";n+=o===R?w+st:c>=0?(i.push(m),w.slice(0,c)+Pe+w.slice(c))+v+k:w+v+(c===-2?p:k)}let l=n+(e[s]||"<?>")+(t===F?"</svg>":t===Y?"</math>":"");return[Ne(e,l),i]};class z{constructor({strings:e,["_$litType$"]:t},s){this.parts=[];let i,n=0,r=0,o=e.length-1,l=this.parts,[p,w]=mt(e,t);if(this.el=z.createElement(p,s),O.currentNode=this.el.content,t===F||t===Y){let c=this.el.content.firstChild;c.replaceWith(...c.childNodes)}while((i=O.nextNode())!==null&&l.length<o){if(i.nodeType===1){{let c=i.localName;if(/^(?:textarea|template)$/i.test(c)&&i.innerHTML.includes(v)){let m=`Expressions are not supported inside \`${c}\` elements. See https://lit.dev/msg/expression-in-${c} for more information.`;if(c==="template")throw Error(m);else U("",m)}}if(i.hasAttributes()){for(let c of i.getAttributeNames())if(c.endsWith(Pe)){let m=w[r++],u=i.getAttribute(c).split(v),k=/([.?@])?(.*)/.exec(m);l.push({type:ae,index:n,name:k[2],strings:u,ctor:k[1]==="."?Ae:k[1]==="?"?De:k[1]==="@"?Me:B}),i.removeAttribute(c)}else if(c.startsWith(v))l.push({type:le,index:n}),i.removeAttribute(c)}if(Oe.test(i.tagName)){let c=i.textContent.split(v),m=c.length-1;if(m>0){i.textContent=q?q.emptyScript:"";for(let T=0;T<m;T++)i.append(c[T],I()),O.nextNode(),l.push({type:K,index:++n});i.append(c[m],I())}}}else if(i.nodeType===8)if(i.data===ke)l.push({type:K,index:n});else{let m=-1;while((m=i.data.indexOf(v,m+1))!==-1)l.push({type:ut,index:n}),m+=v.length-1}n++}if(w.length!==r)throw Error('Detected duplicate attribute bindings. This occurs if your template has duplicate attributes on an element tag. For example "<input ?disabled=${true} ?disabled=${false}>" contains a duplicate "disabled" attribute. The error was detected in the following template: \n`'+e.join("${...}")+"`");a&&a({kind:"template prep",template:this,clonableTemplate:this.el,parts:this.parts,strings:e})}static createElement(e,t){let s=N.createElement("template");return s.innerHTML=e,s}}function M(e,t,s=e,i){if(t===C)return t;let n=i!==void 0?s.__directives?.[i]:s.__directive,r=L(t)?void 0:t._$litDirective$;if(n?.constructor!==r){if(n?._$notifyDirectiveConnectionChanged?.(!1),r===void 0)n=void 0;else n=new r(e),n._$initialize(e,s,i);if(i!==void 0)(s.__directives??=[])[i]=n;else s.__directive=n}if(n!==void 0)t=M(e,n._$resolve(e,t.values),n,i);return t}class Ce{constructor(e,t){this._$parts=[],this._$disconnectableChildren=void 0,this._$template=e,this._$parent=t}get parentNode(){return this._$parent.parentNode}get _$isConnected(){return this._$parent._$isConnected}_clone(e){let{el:{content:t},parts:s}=this._$template,i=(e?.creationScope??N).importNode(t,!0);O.currentNode=i;let n=O.nextNode(),r=0,o=0,l=s[0];while(l!==void 0){if(r===l.index){let p;if(l.type===K)p=new H(n,n.nextSibling,this,e);else if(l.type===ae)p=new l.ctor(n,l.name,l.strings,this,e);else if(l.type===le)p=new Re(n,this,e);this._$parts.push(p),l=s[++o]}if(r!==l?.index)n=O.nextNode(),r++}return O.currentNode=N,i}_update(e){let t=0;for(let s of this._$parts){if(s!==void 0)if(a&&a({kind:"set part",part:s,value:e[t],valueIndex:t,values:e,templateInstance:this}),s.strings!==void 0)s._$setValue(e,s,t),t+=s.strings.length-2;else s._$setValue(e[t]);t++}}}class H{get _$isConnected(){return this._$parent?._$isConnected??this.__isConnected}constructor(e,t,s,i){this.type=K,this._$committedValue=d,this._$disconnectableChildren=void 0,this._$startNode=e,this._$endNode=t,this._$parent=s,this.options=i,this.__isConnected=i?.isConnected??!0,this._textSanitizer=void 0}get parentNode(){let e=E(this._$startNode).parentNode,t=this._$parent;if(t!==void 0&&e?.nodeType===11)e=t.parentNode;return e}get startNode(){return this._$startNode}get endNode(){return this._$endNode}_$setValue(e,t=this){if(this.parentNode===null)throw Error("This `ChildPart` has no `parentNode` and therefore cannot accept a value. This likely means the element containing the part was manipulated in an unsupported way outside of Lit's control such that the part's marker nodes were ejected from DOM. For example, setting the element's `innerHTML` or `textContent` can do this.");if(e=M(this,e,t),L(e)){if(e===d||e==null||e===""){if(this._$committedValue!==d)a&&a({kind:"commit nothing to child",start:this._$startNode,end:this._$endNode,parent:this._$parent,options:this.options}),this._$clear();this._$committedValue=d}else if(e!==this._$committedValue&&e!==C)this._commitText(e)}else if(e._$litType$!==void 0)this._commitTemplateResult(e);else if(e.nodeType!==void 0){if(this.options?.host===e){this._commitText("[probable mistake: rendered a template's host in itself (commonly caused by writing ${this} in a template]"),console.warn("Attempted to render the template host",e,"inside itself. This is almost always a mistake, and in dev mode ","we render some warning text. In production however, we'll ","render it, which will usually result in an error, and sometimes ","in the element disappearing from the DOM.");return}this._commitNode(e)}else if(it(e))this._commitIterable(e);else this._commitText(e)}_insert(e){return E(E(this._$startNode).parentNode).insertBefore(e,this._$endNode)}_commitNode(e){if(this._$committedValue!==e){if(this._$clear(),A!==X){let t=this._$startNode.parentNode?.nodeName;if(t==="STYLE"||t==="SCRIPT"){let s="Forbidden";if(t==="STYLE")s="Lit does not support binding inside style nodes. This is a security risk, as style injection attacks can exfiltrate data and spoof UIs. Consider instead using css`...` literals to compose styles, and do dynamic styling with css custom properties, ::parts, <slot>s, and by mutating the DOM rather than stylesheets.";else s="Lit does not support binding inside script nodes. This is a security risk, as it could allow arbitrary code execution.";throw Error(s)}}a&&a({kind:"commit node",start:this._$startNode,parent:this._$parent,value:e,options:this.options}),this._$committedValue=this._insert(e)}}_commitText(e){if(this._$committedValue!==d&&L(this._$committedValue)){let t=E(this._$startNode).nextSibling;if(this._textSanitizer===void 0)this._textSanitizer=re(t,"data","property");e=this._textSanitizer(e),a&&a({kind:"commit text",node:t,value:e,options:this.options}),t.data=e}else{let t=N.createTextNode("");if(this._commitNode(t),this._textSanitizer===void 0)this._textSanitizer=re(t,"data","property");e=this._textSanitizer(e),a&&a({kind:"commit text",node:t,value:e,options:this.options}),t.data=e}this._$committedValue=e}_commitTemplateResult(e){let{values:t,["_$litType$"]:s}=e,i=typeof s==="number"?this._$getTemplate(e):(s.el===void 0&&(s.el=z.createElement(Ne(s.h,s.h[0]),this.options)),s);if(this._$committedValue?._$template===i)a&&a({kind:"template updating",template:i,instance:this._$committedValue,parts:this._$committedValue._$parts,options:this.options,values:t}),this._$committedValue._update(t);else{let n=new Ce(i,this),r=n._clone(this.options);a&&a({kind:"template instantiated",template:i,instance:n,parts:n._$parts,options:this.options,fragment:r,values:t}),n._update(t),a&&a({kind:"template instantiated and updated",template:i,instance:n,parts:n._$parts,options:this.options,fragment:r,values:t}),this._commitNode(r),this._$committedValue=n}}_$getTemplate(e){let t=Te.get(e.strings);if(t===void 0)Te.set(e.strings,t=new z(e));return t}_commitIterable(e){if(!oe(this._$committedValue))this._$committedValue=[],this._$clear();let t=this._$committedValue,s=0,i;for(let n of e){if(s===t.length)t.push(i=new H(this._insert(I()),this._insert(I()),this,this.options));else i=t[s];i._$setValue(n),s++}if(s<t.length)this._$clear(i&&E(i._$endNode).nextSibling,s),t.length=s}_$clear(e=E(this._$startNode).nextSibling,t){this._$notifyConnectionChanged?.(!1,!0,t);while(e!==this._$endNode){let s=E(e).nextSibling;E(e).remove(),e=s}}setConnected(e){if(this._$parent===void 0)this.__isConnected=e,this._$notifyConnectionChanged?.(e);else throw Error("part.setConnected() may only be called on a RootPart returned from render().")}}class B{get tagName(){return this.element.tagName}get _$isConnected(){return this._$parent._$isConnected}constructor(e,t,s,i,n){if(this.type=ae,this._$committedValue=d,this._$disconnectableChildren=void 0,this.element=e,this.name=t,this._$parent=i,this.options=n,s.length>2||s[0]!==""||s[1]!=="")this._$committedValue=Array(s.length-1).fill(new String),this.strings=s;else this._$committedValue=d;this._sanitizer=void 0}_$setValue(e,t=this,s,i){let n=this.strings,r=!1;if(n===void 0){if(e=M(this,e,t,0),r=!L(e)||e!==this._$committedValue&&e!==C,r)this._$committedValue=e}else{let o=e;e=n[0];let l,p;for(l=0;l<n.length-1;l++){if(p=M(this,o[s+l],t,l),p===C)p=this._$committedValue[l];if(r||=!L(p)||p!==this._$committedValue[l],p===d)e=d;else if(e!==d)e+=(p??"")+n[l+1];this._$committedValue[l]=p}}if(r&&!i)this._commitValue(e)}_commitValue(e){if(e===d)E(this.element).removeAttribute(this.name);else{if(this._sanitizer===void 0)this._sanitizer=A(this.element,this.name,"attribute");e=this._sanitizer(e??""),a&&a({kind:"commit attribute",element:this.element,name:this.name,value:e,options:this.options}),E(this.element).setAttribute(this.name,e??"")}}}class Ae extends B{constructor(){super(...arguments);this.type=ct}_commitValue(e){if(this._sanitizer===void 0)this._sanitizer=A(this.element,this.name,"property");e=this._sanitizer(e),a&&a({kind:"commit property",element:this.element,name:this.name,value:e,options:this.options}),this.element[this.name]=e===d?void 0:e}}class De extends B{constructor(){super(...arguments);this.type=pt}_commitValue(e){a&&a({kind:"commit boolean attribute",element:this.element,name:this.name,value:!!(e&&e!==d),options:this.options}),E(this.element).toggleAttribute(this.name,!!e&&e!==d)}}class Me extends B{constructor(e,t,s,i,n){super(e,t,s,i,n);if(this.type=ht,this.strings!==void 0)throw Error(`A \`<${e.localName}>\` has a \`@${t}=...\` listener with invalid content. Event listeners in templates must have exactly one expression and no surrounding text.`)}_$setValue(e,t=this){if(e=M(this,e,t,0)??d,e===C)return;let s=this._$committedValue,i=e===d&&s!==d||e.capture!==s.capture||e.once!==s.once||e.passive!==s.passive,n=e!==d&&(s===d||i);if(a&&a({kind:"commit event listener",element:this.element,name:this.name,value:e,options:this.options,removeListener:i,addListener:n,oldListener:s}),i)this.element.removeEventListener(this.name,this,s);if(n)this.element.addEventListener(this.name,this,e);this._$committedValue=e}handleEvent(e){if(typeof this._$committedValue==="function")this._$committedValue.call(this.options?.host??this.element,e);else this._$committedValue.handleEvent(e)}}class Re{constructor(e,t,s){this.element=e,this.type=le,this._$disconnectableChildren=void 0,this._$parent=t,this.options=s}get _$isConnected(){return this._$parent._$isConnected}_$setValue(e){a&&a({kind:"commit to element binding",element:this.element,value:e,options:this.options}),M(this,e)}}var ft=y.litHtmlPolyfillSupportDevMode;ft?.(z,H);(y.litHtmlVersions??=[]).push("3.3.3");if(y.litHtmlVersions.length>1)queueMicrotask(()=>{U("multiple-versions","Multiple versions of Lit loaded. Loading multiple versions is not recommended.")});var V=(e,t,s)=>{if(t==null)throw TypeError(`The container to render into may not be ${t}`);let i=Qe++,n=s?.renderBefore??t,r=n._$litPart$;if(a&&a({kind:"begin render",id:i,value:e,container:t,options:s,part:r}),r===void 0){let o=s?.renderBefore??null;n._$litPart$=r=new H(t.insertBefore(I(),o),o,void 0,s??{})}return r._$setValue(e),a&&a({kind:"end render",id:i,value:e,container:t,options:s,part:r}),r};V.setSanitizer=et,V.createSanitizer=re,V._testOnlyClearSanitizerFactoryDoNotCallOrElse=tt;var _t=(e,t)=>e,ce=!0,x=globalThis,Ve;if(ce)x.litIssuedWarnings??=new Set,Ve=(e,t)=>{if(t+=` See https://lit.dev/msg/${e} for more information.`,!x.litIssuedWarnings.has(t)&&!x.litIssuedWarnings.has(e))console.warn(t),x.litIssuedWarnings.add(t)};class S extends g{constructor(){super(...arguments);this.renderOptions={host:this},this.__childPart=void 0}createRenderRoot(){let e=super.createRenderRoot();return this.renderOptions.renderBefore??=e.firstChild,e}update(e){let t=this.render();if(!this.hasUpdated)this.renderOptions.isConnected=this.isConnected;super.update(e),this.__childPart=V(t,this.renderRoot,this.renderOptions)}connectedCallback(){super.connectedCallback(),this.__childPart?.setConnected(!0)}disconnectedCallback(){super.disconnectedCallback(),this.__childPart?.setConnected(!1)}render(){return C}}S._$litElement$=!0;S[_t("finalized",S)]=!0;x.litElementHydrateSupport?.({LitElement:S});var gt=ce?x.litElementPolyfillSupportDevMode:x.litElementPolyfillSupport;gt?.({LitElement:S});(x.litElementVersions??=[]).push("4.2.2");if(ce&&x.litElementVersions.length>1)queueMicrotask(()=>{Ve("multiple-versions","Multiple versions of Lit loaded. Loading multiple versions is not recommended.")});var Ue=[["prompt.condense","condense"],["prompt.enhance","enhance (local LLM)"],["prompt.debug","debug preview"],["prompt.log","log all stages"]],pe={"prompt.condense":!0,"prompt.enhance":!1,"prompt.debug":!1,"prompt.log":!1};class Ie extends S{static properties={settings:{state:!0},view:{state:!0},busy:{state:!0},err:{state:!0},sent:{state:!0}};static styles=j`
		:host {
			display: block;
			margin: 4px 0;
			font: 12px/1.45 ui-sans-serif, system-ui;
			color: var(--klh-ink, #e8e4da);
		}
		summary {
			cursor: pointer;
			color: var(--klh-dim, #97917f);
		}
		.toggles {
			display: flex;
			flex-wrap: wrap;
			gap: 12px;
			padding: 4px 0;
		}
		.pv {
			margin-top: 6px;
			padding: 8px;
			border: 1px solid var(--klh-edge, #8a8577);
			border-left: 3px solid var(--klh-accent, #d9a53a);
			border-radius: 6px;
			background: var(--klh-surface, #23211d);
		}
		.hd {
			display: flex;
			flex-wrap: wrap;
			gap: 8px;
			align-items: baseline;
		}
		.dim {
			color: var(--klh-dim, #97917f);
		}
		pre {
			margin: 4px 0;
			padding: 6px 8px;
			white-space: pre-wrap;
			word-break: break-word;
			max-height: 16em;
			overflow: auto;
			font: 12px/1.4 ui-monospace, monospace;
			background: rgb(0 0 0 / 0.18);
			border-radius: 4px;
			user-select: text;
		}
		.err {
			color: #e07a5f;
		}
		.actions {
			display: flex;
			gap: 8px;
			margin-top: 6px;
		}
		button {
			font: inherit;
			cursor: pointer;
			padding: 3px 10px;
			border: 1px solid var(--klh-edge, #8a8577);
			border-radius: 6px;
			background: var(--klh-surface, #23211d);
			color: var(--klh-ink, #e8e4da);
		}
		button.go {
			border-color: var(--klh-accent, #d9a53a);
			font-weight: 600;
		}
		button:disabled {
			opacity: 0.5;
			cursor: default;
		}
	`;project="";goal="";previewId=null;constructor(){super();this.settings={...pe},this.view=null,this.busy=!1,this.err=null,this.sent=!1}get gated(){return this.settings["prompt.debug"]||this.settings["prompt.log"]}ready(e){return!this.busy&&!this.sent&&this.goal===e&&!!this.project}connectedCallback(){super.connectedCallback(),this.loadSettings()}async loadSettings(){try{let t=await(await fetch("/api/prompt/settings")).json();if(t.settings)this.settings={...pe,...t.settings}}catch{}}async toggle(e,t){let s=this.settings;this.settings={...s,[e]:t};try{let i=await fetch("/api/prompt/settings",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({[e]:t})}),n=await i.json();if(!i.ok||!n.settings)throw Error(n.error??`HTTP ${i.status}`);this.settings={...pe,...n.settings}}catch(i){this.settings=s,this.err=`settings not saved: ${i instanceof Error?i.message:String(i)}`}}async prepare(e,t){this.project=e,this.goal=t,this.previewId=null,this.view=null,this.err=null,this.sent=!1,this.busy=!0;try{let s=await fetch("/api/orchestrate/preview",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({project:e,goal:t}),signal:AbortSignal.timeout(30000)}),i=await s.json();if(!s.ok||!i.ok||!i.preview)throw Error(i.error??`HTTP ${s.status}`);this.view=i.preview,this.previewId=i.previewId??null}catch(s){this.err=`preview failed: ${s instanceof Error?s.message:String(s)}`}finally{this.busy=!1}}clear(){this.view=null,this.err=null,this.sent=!1,this.goal="",this.project="",this.previewId=null}dispatch(){if(this.busy||this.sent||!this.project)return;this.sent=!0,this.dispatchEvent(new CustomEvent("klh-dispatch",{bubbles:!0,composed:!0,detail:{project:this.project,goal:this.goal,previewId:this.previewId}}))}block(e,t){return h`<details ?open=${t}>
			<summary>${e.label} · ${e.bytes} B</summary>
			<pre>${e.text}</pre>
		</details>`}summary(){let e=Ue.filter(([t])=>this.settings[t]).map(([,t])=>t);return`prompt transforms · ${e.length?e.join(", "):"all off"}`}body(){if(!this.busy&&!this.view&&!this.err)return d;let e=this.view;return h`<section class="pv" aria-live="polite" aria-label="dispatch preview">
			<div class="hd">
				<strong>${this.sent?"dispatched":"will dispatch"}</strong>
				${e?h`<span class="dim"
								>${e.finalBytes} B · condense ${e.ran.condense?"ran":"off"} ·
								enhance ${e.ran.enhance?"ran":"off"}${e.wireBytes?` · ${e.wireBytes} B on the wire`:""}</span
							>`:d}
			</div>
			${this.busy?h`<div class="dim">preparing preview…</div>`:d}
			${this.err?h`<div class="err">${this.err}</div>`:d}
			${e?.enhanceNote?h`<div class="dim">${e.enhanceNote}</div>`:d}
			${e?h`<pre aria-label="final prompt">${e.final}</pre>`:d}
			${e?.stages?.length?h`<div class="dim">stages</div>
							${e.stages.map((t)=>this.block(t,!1))}`:d}
			${e?.injected?.length?h`<div class="dim">injected context (appended to the prompt)</div>
							${e.injected.map((t)=>this.block(t,!1))}`:d}
			${this.sent||!this.project?d:h`<div class="actions">
							<button
								class="go"
								type="button"
								?disabled=${this.busy}
								@click=${this.dispatch}
							>
								dispatch anyway ⏎
							</button>
							<button type="button" @click=${this.clear}>cancel</button>
						</div>`}
		</section>`}render(){return h`
			<details>
				<summary>${this.summary()}</summary>
				<div class="toggles">
					${Ue.map(([e,t])=>h`<label>
							<input
								type="checkbox"
								.checked=${this.settings[e]}
								@change=${(s)=>this.toggle(e,s.target.checked)}
							/>
							${t}
						</label>`)}
				</div>
			</details>
			${this.body()}
		`}}customElements.define("klh-prompt-preview",Ie);class Le extends S{static properties={eventId:{type:Number,attribute:"event-id"},count:{state:!0},latest:{state:!0},busy:{state:!0},err:{state:!0}};static styles=j`
		:host {
			display: block;
			margin-top: 6px;
			font: 12px/1.45 ui-sans-serif, system-ui;
		}
		.row {
			display: flex;
			gap: 8px;
			align-items: center;
		}
		button {
			font: inherit;
			cursor: pointer;
			padding: 3px 10px;
			border: 1px solid var(--klh-edge, #8a8577);
			border-radius: 6px;
			background: var(--klh-surface, #23211d);
			color: var(--klh-ink, #e8e4da);
		}
		button:hover {
			border-color: var(--klh-accent, #d9a53a);
		}
		button:disabled {
			opacity: 0.5;
			cursor: default;
		}
		.cnt {
			color: var(--klh-dim, #97917f);
		}
		output {
			display: block;
			margin-top: 6px;
			white-space: pre-wrap;
			color: var(--klh-ink, #e8e4da);
			border-left: 2px solid var(--klh-accent, #d9a53a);
			padding-left: 8px;
		}
		output.err {
			color: #e07a5f;
			border-left-color: #e07a5f;
		}
	`;constructor(){super();this.count=0,this.latest=null,this.busy=!1,this.err=null}connectedCallback(){super.connectedCallback(),this.hydrate()}async hydrate(){if(!this.eventId)return;try{let e=await fetch(`/api/decisions/${this.eventId}/evals`);if(!e.ok)return;let t=await e.json();this.apply(t.evals??[])}catch{}}apply(e,t){this.count=t??e.length,this.latest=e[e.length-1]??null,this.err=null}async evaluate(){if(this.busy||!this.eventId)return;this.busy=!0,this.err=null;try{let e=await fetch(`/api/decisions/${this.eventId}/evaluate`,{method:"POST"}),t=await e.json();if(!e.ok||!t.ok)throw Error(t.error??`HTTP ${e.status}`);if(t.latest)this.apply([t.latest],t.count)}catch(e){this.err=e instanceof Error?e.message:String(e)}finally{this.busy=!1}}when(e){return new Date(e).toLocaleTimeString()}render(){return h`
			<div class="row">
				<button
					?disabled=${this.busy}
					@click=${this.evaluate}
					type="button"
				>
					${this.busy?"evaluating…":"re-evaluate"}
				</button>
				<span class="cnt">
					${this.count}
					${this.count===1?"evaluation":"evaluations"}
				</span>
			</div>
			${this.err?h`<output class="err">${this.err}</output>`:""}
			${this.latest?h`<output>
						${this.when(this.latest.ts)} — ${this.latest.text}
					</output>`:""}
		`}}customElements.define("klh-decision-eval",Le);function ze(){let e=document.querySelectorAll(".dec[data-id]");for(let t of e){if(t.querySelector("klh-decision-eval"))continue;let s=t.querySelector(".dec-actions")??t,i=document.createElement("klh-decision-eval");i.setAttribute("event-id",t.getAttribute("data-id")??""),s.appendChild(i)}}var yt=new MutationObserver(ze);function He(){let e=document.querySelector("#decisions");if(!e){setTimeout(He,300);return}yt.observe(e,{childList:!0,subtree:!0}),ze()}He();
