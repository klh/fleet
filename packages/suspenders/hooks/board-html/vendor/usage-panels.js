var D=globalThis,I=D.ShadowRoot&&(D.ShadyCSS===void 0||D.ShadyCSS.nativeShadow)&&"adoptedStyleSheets"in Document.prototype&&"replace"in CSSStyleSheet.prototype,K=Symbol(),me=new WeakMap;class j{constructor(e,t,a){if(this._$cssResult$=!0,a!==K)throw Error("CSSResult is not constructable. Use `unsafeCSS` or `css` instead.");this.cssText=e,this.t=t}get styleSheet(){let e=this.o,t=this.t;if(I&&e===void 0){let a=t!==void 0&&t.length===1;a&&(e=me.get(t)),e===void 0&&((this.o=e=new CSSStyleSheet).replaceSync(this.cssText),a&&me.set(t,e))}return e}toString(){return this.cssText}}var ge=(e)=>new j(typeof e=="string"?e:e+"",void 0,K),g=(e,...t)=>{let a=e.length===1?e[0]:t.reduce((s,r,n)=>s+((l)=>{if(l._$cssResult$===!0)return l.cssText;if(typeof l=="number")return l;throw Error("Value passed to 'css' function must be a 'css' function result: "+l+". Use 'unsafeCSS' to pass non-literal values, but take care to ensure page security.")})(r)+e[n+1],e[0]);return new j(a,e,K)},be=(e,t)=>{if(I)e.adoptedStyleSheets=t.map((a)=>a instanceof CSSStyleSheet?a:a.styleSheet);else for(let a of t){let s=document.createElement("style"),r=D.litNonce;r!==void 0&&s.setAttribute("nonce",r),s.textContent=a.cssText,e.appendChild(s)}},V=I?(e)=>e:(e)=>e instanceof CSSStyleSheet?((t)=>{let a="";for(let s of t.cssRules)a+=s.cssText;return ge(a)})(e):e;var{is:Le,defineProperty:qe,getOwnPropertyDescriptor:ze,getOwnPropertyNames:De,getOwnPropertySymbols:Ie,getPrototypeOf:je}=Object,B=globalThis,fe=B.trustedTypes,Be=fe?fe.emptyScript:"",We=B.reactiveElementPolyfillSupport,P=(e,t)=>e,Y={toAttribute(e,t){switch(t){case Boolean:e=e?Be:null;break;case Object:case Array:e=e==null?e:JSON.stringify(e)}return e},fromAttribute(e,t){let a=e;switch(t){case Boolean:a=e!==null;break;case Number:a=e===null?null:Number(e);break;case Object:case Array:try{a=JSON.parse(e)}catch(s){a=null}}return a}},ve=(e,t)=>!Le(e,t),$e={attribute:!0,type:String,converter:Y,reflect:!1,useDefault:!1,hasChanged:ve};Symbol.metadata??=Symbol("metadata"),B.litPropertyMetadata??=new WeakMap;class k extends HTMLElement{static addInitializer(e){this._$Ei(),(this.l??=[]).push(e)}static get observedAttributes(){return this.finalize(),this._$Eh&&[...this._$Eh.keys()]}static createProperty(e,t=$e){if(t.state&&(t.attribute=!1),this._$Ei(),this.prototype.hasOwnProperty(e)&&((t=Object.create(t)).wrapped=!0),this.elementProperties.set(e,t),!t.noAccessor){let a=Symbol(),s=this.getPropertyDescriptor(e,a,t);s!==void 0&&qe(this.prototype,e,s)}}static getPropertyDescriptor(e,t,a){let{get:s,set:r}=ze(this.prototype,e)??{get(){return this[t]},set(n){this[t]=n}};return{get:s,set(n){let l=s?.call(this);r?.call(this,n),this.requestUpdate(e,l,a)},configurable:!0,enumerable:!0}}static getPropertyOptions(e){return this.elementProperties.get(e)??$e}static _$Ei(){if(this.hasOwnProperty(P("elementProperties")))return;let e=je(this);e.finalize(),e.l!==void 0&&(this.l=[...e.l]),this.elementProperties=new Map(e.elementProperties)}static finalize(){if(this.hasOwnProperty(P("finalized")))return;if(this.finalized=!0,this._$Ei(),this.hasOwnProperty(P("properties"))){let t=this.properties,a=[...De(t),...Ie(t)];for(let s of a)this.createProperty(s,t[s])}let e=this[Symbol.metadata];if(e!==null){let t=litPropertyMetadata.get(e);if(t!==void 0)for(let[a,s]of t)this.elementProperties.set(a,s)}this._$Eh=new Map;for(let[t,a]of this.elementProperties){let s=this._$Eu(t,a);s!==void 0&&this._$Eh.set(s,t)}this.elementStyles=this.finalizeStyles(this.styles)}static finalizeStyles(e){let t=[];if(Array.isArray(e)){let a=new Set(e.flat(1/0).reverse());for(let s of a)t.unshift(V(s))}else e!==void 0&&t.push(V(e));return t}static _$Eu(e,t){let a=t.attribute;return a===!1?void 0:typeof a=="string"?a:typeof e=="string"?e.toLowerCase():void 0}constructor(){super(),this._$Ep=void 0,this.isUpdatePending=!1,this.hasUpdated=!1,this._$Em=null,this._$Ev()}_$Ev(){this._$ES=new Promise((e)=>this.enableUpdating=e),this._$AL=new Map,this._$E_(),this.requestUpdate(),this.constructor.l?.forEach((e)=>e(this))}addController(e){(this._$EO??=new Set).add(e),this.renderRoot!==void 0&&this.isConnected&&e.hostConnected?.()}removeController(e){this._$EO?.delete(e)}_$E_(){let e=new Map,t=this.constructor.elementProperties;for(let a of t.keys())this.hasOwnProperty(a)&&(e.set(a,this[a]),delete this[a]);e.size>0&&(this._$Ep=e)}createRenderRoot(){let e=this.shadowRoot??this.attachShadow(this.constructor.shadowRootOptions);return be(e,this.constructor.elementStyles),e}connectedCallback(){this.renderRoot??=this.createRenderRoot(),this.enableUpdating(!0),this._$EO?.forEach((e)=>e.hostConnected?.())}enableUpdating(e){}disconnectedCallback(){this._$EO?.forEach((e)=>e.hostDisconnected?.())}attributeChangedCallback(e,t,a){this._$AK(e,a)}_$ET(e,t){let a=this.constructor.elementProperties.get(e),s=this.constructor._$Eu(e,a);if(s!==void 0&&a.reflect===!0){let r=(a.converter?.toAttribute!==void 0?a.converter:Y).toAttribute(t,a.type);this._$Em=e,r==null?this.removeAttribute(s):this.setAttribute(s,r),this._$Em=null}}_$AK(e,t){let a=this.constructor,s=a._$Eh.get(e);if(s!==void 0&&this._$Em!==s){let r=a.getPropertyOptions(s),n=typeof r.converter=="function"?{fromAttribute:r.converter}:r.converter?.fromAttribute!==void 0?r.converter:Y;this._$Em=s;let l=n.fromAttribute(t,r.type);this[s]=l??this._$Ej?.get(s)??l,this._$Em=null}}requestUpdate(e,t,a,s=!1,r){if(e!==void 0){let n=this.constructor;if(s===!1&&(r=this[e]),a??=n.getPropertyOptions(e),!((a.hasChanged??ve)(r,t)||a.useDefault&&a.reflect&&r===this._$Ej?.get(e)&&!this.hasAttribute(n._$Eu(e,a))))return;this.C(e,t,a)}this.isUpdatePending===!1&&(this._$ES=this._$EP())}C(e,t,{useDefault:a,reflect:s,wrapped:r},n){a&&!(this._$Ej??=new Map).has(e)&&(this._$Ej.set(e,n??t??this[e]),r!==!0||n!==void 0)||(this._$AL.has(e)||(this.hasUpdated||a||(t=void 0),this._$AL.set(e,t)),s===!0&&this._$Em!==e&&(this._$Eq??=new Set).add(e))}async _$EP(){this.isUpdatePending=!0;try{await this._$ES}catch(t){Promise.reject(t)}let e=this.scheduleUpdate();return e!=null&&await e,!this.isUpdatePending}scheduleUpdate(){return this.performUpdate()}performUpdate(){if(!this.isUpdatePending)return;if(!this.hasUpdated){if(this.renderRoot??=this.createRenderRoot(),this._$Ep){for(let[s,r]of this._$Ep)this[s]=r;this._$Ep=void 0}let a=this.constructor.elementProperties;if(a.size>0)for(let[s,r]of a){let{wrapped:n}=r,l=this[s];n!==!0||this._$AL.has(s)||l===void 0||this.C(s,void 0,r,l)}}let e=!1,t=this._$AL;try{e=this.shouldUpdate(t),e?(this.willUpdate(t),this._$EO?.forEach((a)=>a.hostUpdate?.()),this.update(t)):this._$EM()}catch(a){throw e=!1,this._$EM(),a}e&&this._$AE(t)}willUpdate(e){}_$AE(e){this._$EO?.forEach((t)=>t.hostUpdated?.()),this.hasUpdated||(this.hasUpdated=!0,this.firstUpdated(e)),this.updated(e)}_$EM(){this._$AL=new Map,this.isUpdatePending=!1}get updateComplete(){return this.getUpdateComplete()}getUpdateComplete(){return this._$ES}shouldUpdate(e){return!0}update(e){this._$Eq&&=this._$Eq.forEach((t)=>this._$ET(t,this[t])),this._$EM()}updated(e){}firstUpdated(e){}}k.elementStyles=[],k.shadowRootOptions={mode:"open"},k[P("elementProperties")]=new Map,k[P("finalized")]=new Map,We?.({ReactiveElement:k}),(B.reactiveElementVersions??=[]).push("2.1.2");var G=globalThis,ye=(e)=>e,W=G.trustedTypes,xe=W?W.createPolicy("lit-html",{createHTML:(e)=>e}):void 0;var w=`lit$${Math.random().toFixed(9).slice(2)}$`,Ee="?"+w,Fe=`<${Ee}>`,A=document,O=()=>A.createComment(""),M=(e)=>e===null||typeof e!="object"&&typeof e!="function",J=Array.isArray,Ke=(e)=>J(e)||typeof e?.[Symbol.iterator]=="function";var H=/<(?:(!--|\/[^a-zA-Z])|(\/?[a-zA-Z][^>\s]*)|(\/?$))/g,ke=/-->/g,we=/>/g,_=RegExp(`>|[ 	
\f\r](?:([^\\s"'>=/]+)([ 	
\f\r]*=[ 	
\f\r]*(?:[^ 	
\f\r"'\`<>=]|("|')|))|$)`,"g"),_e=/'/g,Se=/"/g,Re=/^(?:script|style|textarea|title)$/i,Q=(e)=>(t,...a)=>({_$litType$:e,strings:t,values:a}),i=Q(1),at=Q(2),rt=Q(3),E=Symbol.for("lit-noChange"),d=Symbol.for("lit-nothing"),Ae=new WeakMap,S=A.createTreeWalker(A,129);function Ce(e,t){if(!J(e)||!e.hasOwnProperty("raw"))throw Error("invalid template strings array");return xe!==void 0?xe.createHTML(t):t}var Ve=(e,t)=>{let a=e.length-1,s=[],r,n=t===2?"<svg>":t===3?"<math>":"",l=H;for(let o=0;o<a;o++){let h=e[o],b,c,u=-1,y=0;for(;y<h.length&&(l.lastIndex=y,c=l.exec(h),c!==null);)y=l.lastIndex,l===H?c[1]==="!--"?l=ke:c[1]!==void 0?l=we:c[2]!==void 0?(Re.test(c[2])&&(r=RegExp("</"+c[2],"g")),l=_):c[3]!==void 0&&(l=_):l===_?c[0]===">"?(l=r??H,u=-1):c[1]===void 0?u=-2:(u=l.lastIndex-c[2].length,b=c[1],l=c[3]===void 0?_:c[3]==='"'?Se:_e):l===Se||l===_e?l=_:l===ke||l===we?l=H:(l=_,r=void 0);let x=l===_&&e[o+1].startsWith("/>")?" ":"";n+=l===H?h+Fe:u>=0?(s.push(b),h.slice(0,u)+"$lit$"+h.slice(u)+w+x):h+w+(u===-2?o:x)}return[Ce(e,n+(e[a]||"<?>")+(t===2?"</svg>":t===3?"</math>":"")),s]};class N{constructor({strings:e,_$litType$:t},a){let s;this.parts=[];let r=0,n=0,l=e.length-1,o=this.parts,[h,b]=Ve(e,t);if(this.el=N.createElement(h,a),S.currentNode=this.el.content,t===2||t===3){let c=this.el.content.firstChild;c.replaceWith(...c.childNodes)}for(;(s=S.nextNode())!==null&&o.length<l;){if(s.nodeType===1){if(s.hasAttributes())for(let c of s.getAttributeNames())if(c.endsWith("$lit$")){let u=b[n++],y=s.getAttribute(c).split(w),x=/([.?@])?(.*)/.exec(u);o.push({type:1,index:r,name:x[2],strings:y,ctor:x[1]==="."?Ue:x[1]==="?"?Pe:x[1]==="@"?He:q}),s.removeAttribute(c)}else c.startsWith(w)&&(o.push({type:6,index:r}),s.removeAttribute(c));if(Re.test(s.tagName)){let c=s.textContent.split(w),u=c.length-1;if(u>0){s.textContent=W?W.emptyScript:"";for(let y=0;y<u;y++)s.append(c[y],O()),S.nextNode(),o.push({type:2,index:++r});s.append(c[u],O())}}}else if(s.nodeType===8)if(s.data===Ee)o.push({type:2,index:r});else{let c=-1;for(;(c=s.data.indexOf(w,c+1))!==-1;)o.push({type:7,index:r}),c+=w.length-1}r++}}static createElement(e,t){let a=A.createElement("template");return a.innerHTML=e,a}}function R(e,t,a=e,s){if(t===E)return t;let r=s!==void 0?a._$Co?.[s]:a._$Cl,n=M(t)?void 0:t._$litDirective$;return r?.constructor!==n&&(r?._$AO?.(!1),n===void 0?r=void 0:(r=new n(e),r._$AT(e,a,s)),s!==void 0?(a._$Co??=[])[s]=r:a._$Cl=r),r!==void 0&&(t=R(e,r._$AS(e,t.values),r,s)),t}class Te{constructor(e,t){this._$AV=[],this._$AN=void 0,this._$AD=e,this._$AM=t}get parentNode(){return this._$AM.parentNode}get _$AU(){return this._$AM._$AU}u(e){let{el:{content:t},parts:a}=this._$AD,s=(e?.creationScope??A).importNode(t,!0);S.currentNode=s;let r=S.nextNode(),n=0,l=0,o=a[0];for(;o!==void 0;){if(n===o.index){let h;o.type===2?h=new L(r,r.nextSibling,this,e):o.type===1?h=new o.ctor(r,o.name,o.strings,this,e):o.type===6&&(h=new Oe(r,this,e)),this._$AV.push(h),o=a[++l]}n!==o?.index&&(r=S.nextNode(),n++)}return S.currentNode=A,s}p(e){let t=0;for(let a of this._$AV)a!==void 0&&(a.strings!==void 0?(a._$AI(e,a,t),t+=a.strings.length-2):a._$AI(e[t])),t++}}class L{get _$AU(){return this._$AM?._$AU??this._$Cv}constructor(e,t,a,s){this.type=2,this._$AH=d,this._$AN=void 0,this._$AA=e,this._$AB=t,this._$AM=a,this.options=s,this._$Cv=s?.isConnected??!0}get parentNode(){let e=this._$AA.parentNode,t=this._$AM;return t!==void 0&&e?.nodeType===11&&(e=t.parentNode),e}get startNode(){return this._$AA}get endNode(){return this._$AB}_$AI(e,t=this){e=R(this,e,t),M(e)?e===d||e==null||e===""?(this._$AH!==d&&this._$AR(),this._$AH=d):e!==this._$AH&&e!==E&&this._(e):e._$litType$!==void 0?this.$(e):e.nodeType!==void 0?this.T(e):Ke(e)?this.k(e):this._(e)}O(e){return this._$AA.parentNode.insertBefore(e,this._$AB)}T(e){this._$AH!==e&&(this._$AR(),this._$AH=this.O(e))}_(e){this._$AH!==d&&M(this._$AH)?this._$AA.nextSibling.data=e:this.T(A.createTextNode(e)),this._$AH=e}$(e){let{values:t,_$litType$:a}=e,s=typeof a=="number"?this._$AC(e):(a.el===void 0&&(a.el=N.createElement(Ce(a.h,a.h[0]),this.options)),a);if(this._$AH?._$AD===s)this._$AH.p(t);else{let r=new Te(s,this),n=r.u(this.options);r.p(t),this.T(n),this._$AH=r}}_$AC(e){let t=Ae.get(e.strings);return t===void 0&&Ae.set(e.strings,t=new N(e)),t}k(e){J(this._$AH)||(this._$AH=[],this._$AR());let t=this._$AH,a,s=0;for(let r of e)s===t.length?t.push(a=new L(this.O(O()),this.O(O()),this,this.options)):a=t[s],a._$AI(r),s++;s<t.length&&(this._$AR(a&&a._$AB.nextSibling,s),t.length=s)}_$AR(e=this._$AA.nextSibling,t){for(this._$AP?.(!1,!0,t);e!==this._$AB;){let a=ye(e).nextSibling;ye(e).remove(),e=a}}setConnected(e){this._$AM===void 0&&(this._$Cv=e,this._$AP?.(e))}}class q{get tagName(){return this.element.tagName}get _$AU(){return this._$AM._$AU}constructor(e,t,a,s,r){this.type=1,this._$AH=d,this._$AN=void 0,this.element=e,this.name=t,this._$AM=s,this.options=r,a.length>2||a[0]!==""||a[1]!==""?(this._$AH=Array(a.length-1).fill(new String),this.strings=a):this._$AH=d}_$AI(e,t=this,a,s){let r=this.strings,n=!1;if(r===void 0)e=R(this,e,t,0),n=!M(e)||e!==this._$AH&&e!==E,n&&(this._$AH=e);else{let l=e,o,h;for(e=r[0],o=0;o<r.length-1;o++)h=R(this,l[a+o],t,o),h===E&&(h=this._$AH[o]),n||=!M(h)||h!==this._$AH[o],h===d?e=d:e!==d&&(e+=(h??"")+r[o+1]),this._$AH[o]=h}n&&!s&&this.j(e)}j(e){e===d?this.element.removeAttribute(this.name):this.element.setAttribute(this.name,e??"")}}class Ue extends q{constructor(){super(...arguments),this.type=3}j(e){this.element[this.name]=e===d?void 0:e}}class Pe extends q{constructor(){super(...arguments),this.type=4}j(e){this.element.toggleAttribute(this.name,!!e&&e!==d)}}class He extends q{constructor(e,t,a,s,r){super(e,t,a,s,r),this.type=5}_$AI(e,t=this){if((e=R(this,e,t,0)??d)===E)return;let a=this._$AH,s=e===d&&a!==d||e.capture!==a.capture||e.once!==a.once||e.passive!==a.passive,r=e!==d&&(a===d||s);s&&this.element.removeEventListener(this.name,this,a),r&&this.element.addEventListener(this.name,this,e),this._$AH=e}handleEvent(e){typeof this._$AH=="function"?this._$AH.call(this.options?.host??this.element,e):this._$AH.handleEvent(e)}}class Oe{constructor(e,t,a){this.element=e,this.type=6,this._$AN=void 0,this._$AM=t,this.options=a}get _$AU(){return this._$AM._$AU}_$AI(e){R(this,e)}}var Ye=G.litHtmlPolyfillSupport;Ye?.(N,L),(G.litHtmlVersions??=[]).push("3.3.3");var Me=(e,t,a)=>{let s=a?.renderBefore??t,r=s._$litPart$;if(r===void 0){let n=a?.renderBefore??null;s._$litPart$=r=new L(t.insertBefore(O(),n),n,void 0,a??{})}return r._$AI(e),r};var X=globalThis;class m extends k{constructor(){super(...arguments),this.renderOptions={host:this},this._$Do=void 0}createRenderRoot(){let e=super.createRenderRoot();return this.renderOptions.renderBefore??=e.firstChild,e}update(e){let t=this.render();this.hasUpdated||(this.renderOptions.isConnected=this.isConnected),super.update(e),this._$Do=Me(t,this.renderRoot,this.renderOptions)}connectedCallback(){super.connectedCallback(),this._$Do?.setConnected(!0)}disconnectedCallback(){super.disconnectedCallback(),this._$Do?.setConnected(!1)}render(){return E}}m._$litElement$=!0,m.finalized=!0,X.litElementHydrateSupport?.({LitElement:m});var Ge=X.litElementPolyfillSupport;Ge?.({LitElement:m});(X.litElementVersions??=[]).push("4.2.2");var Je=()=>{let e=document.getElementById("usage-data");if(!e)return null;try{return JSON.parse(e.textContent??"").head??null}catch{return null}};class Z extends m{static properties={head:{type:Object,state:!0}};constructor(){super();this.head=null}connectedCallback(){super.connectedCallback(),this.head=Je()}render(){let e=this.head;if(e===null)return d;return i`<h1 class="utitle">${e.title}</h1>
			<div class="uback">
				<a href=${e.backHref}>&larr; ${e.backLabel}</a>
				<span class=${e.note.kind==="on"?"uon":"uwin"}
					>${e.note.text}</span
				>
			</div>
			<div class="ufilters">
				${e.filters.map((t)=>i`<span class="ufgroup" data-label=${t.label}>
						${t.options.map((a)=>i`<a class=${a.on?"ufilter on":"ufilter"} href=${a.href}
									>${a.label}</a
								>`)}
					</span>`)}
			</div>`}}Z.styles=g`
	:host {
		display: block;
	}
	a {
		color: var(--klh-accent, #e0a458);
	}
	.utitle {
		font-size: 14px;
		letter-spacing: 0.08em;
		margin: 14px 0 10px;
		color: var(--klh-ink, #e8e6e1);
	}
	.uback {
		display: flex;
		gap: 16px;
		align-items: baseline;
		margin: 12px 0 0;
	}
	.uwin {
		font-size: 10.5px;
		color: var(--klh-dim, #98958e);
	}
	.uon {
		font-size: 10.5px;
		color: var(--klh-accent, #e0a458);
	}
	.ufilters {
		display: flex;
		gap: 18px;
		align-items: center;
		margin: 12px 0 14px;
		flex-wrap: wrap;
	}
	.ufgroup {
		display: flex;
		gap: 6px;
		align-items: center;
	}
	.ufgroup::before {
		content: attr(data-label);
		font-size: 9.5px;
		color: var(--klh-dim, #98958e);
		text-transform: uppercase;
		letter-spacing: 0.06em;
	}
	.ufilter {
		font-size: 11px;
		color: var(--klh-dim, #98958e);
		text-decoration: none;
		border: 1px solid var(--klh-edge, rgba(255, 255, 255, 0.12));
		border-radius: 2px;
		padding: 2px 9px;
	}
	.ufilter.on {
		color: var(--klh-accent, #e0a458);
		border-color: var(--klh-accent, #e0a458);
	}
`;customElements.define("klh-usage-head",Z);var v=(e)=>e>=1e9?`${(e/1e9).toFixed(1)}B`:e>=1e6?`${(e/1e6).toFixed(1)}M`:e>=1000?`${(e/1000).toFixed(1)}K`:String(Math.round(e)),z=(e)=>`${(e*100).toFixed(1)}%`,ee=(e,t=!1)=>{if(e===null)return"—";let a=new Date(e);if(Number.isNaN(a.getTime()))return"—";let s=(n)=>String(n).padStart(2,"0"),r=`${s(a.getHours())}:${s(a.getMinutes())}`;return t?`${r}:${s(a.getSeconds())}`:r};class te extends m{static properties={report:{type:Object,state:!0},err:{type:String,state:!0},loading:{type:Boolean,state:!0},lane:{type:String,state:!0},days:{type:Number,state:!0},model:{type:String,state:!0},day:{type:String,state:!0},missOnly:{type:Boolean,state:!0}};constructor(){super();this.report=null,this.err="",this.loading=!0,this.lane="",this.days=7,this.model="",this.day="",this.missOnly=!1}connectedCallback(){super.connectedCallback(),this.refresh()}refresh(){let e=new URLSearchParams;if(e.set("days",String(this.days)),this.lane)e.set("lane",this.lane);if(this.model)e.set("model",this.model);if(this.day)e.set("day",this.day);if(this.missOnly)e.set("miss_only","1");this.loading=!0,this.err="",fetch(`/api/usage/cache-drill?${e.toString()}`,{signal:AbortSignal.timeout(15000)}).then((t)=>{if(!t.ok)throw Error(`HTTP ${String(t.status)}`);return t.json()}).then((t)=>{this.report=t,this.loading=!1}).catch((t)=>{this.err=String(t.message??t),this.loading=!1})}render(){if(this.err)return i`<div class="upanel">
				<h2>CACHE EFFICIENCY</h2>
				<p class="uempty">drilldown unavailable — ${this.err}</p>
			</div>`;let e=this.report;if(e===null)return i`<div class="upanel">
				<h2>CACHE EFFICIENCY</h2>
				<p class="uempty">loading…</p>
			</div>`;return i`${this.lanePanel(e)} ${this.scopePanel(e)}`}lanePanel(e){let t=e.hubs.filter((s)=>!s.ok),a=e.hubs.filter((s)=>(s.excluded??0)>0);return i`<div class="upanel">
			<div class="uhead">
				<h2>CACHE EFFICIENCY · WARM RATIO PER LANE</h2>
				<p class="ufoot">
					warm = share of requests that HIT provider cache (cache_read &gt; 0)
					· ${String(e.days)}d window
					${t.length>0?i`· <span class="uwarn"
								>${String(t.length)}/${String(e.hubs.length)} sources
								degraded: ${t.map((s)=>s.label).join(", ")}</span
							>`:d}
				</p>
			</div>
			${this.filterRow(e)}
			${e.overall.requests>e.overall.known?i`<p class="uwarn">Cache verdicts are available for
					${String(e.overall.known)} of ${String(e.overall.requests)}
					requests. Warm rates exclude the rest.</p>`:d}
			${e.probes.requests>0?i`<p class="ufoot">Readiness probes: ${String(e.probes.requests)}
					requests in this window (last ${ee(e.probes.last_ts)}), warm
					${e.probes.known>0?z(e.probes.warm_ratio):"—"} — synthetic
					healthcheck traffic, excluded from the lane and model ratios
					above.</p>`:d}
			${e.local_transcripts&&e.local_transcripts.cache_read_tokens>0?i`<p class="ufoot">Local Claude transcripts report
					${v(e.local_transcripts.cache_read_tokens)} cache-read tokens
					across ${v(e.local_transcripts.requests)} requests in this
					window. This total has no Buckle lane attribution${e.local_transcripts.source==="legacy-aggregate"?" and uses the legacy rollup":""}.</p>`:d}
			${t.length>0?i`<p class="uwarn">Missing request data: ${t.map((s)=>`${s.label} (${s.reason??"unavailable"})`).join(", ")}. Rates cover responding sources only.</p>`:d}
			${e.hubs.some((s)=>s.ok&&(s.rawRows??s.rows)>=500)?i`<p class="uwarn">A source reached the 500-request read limit. Rates cover its newest requests only.</p>`:d}
			${a.length>0?i`<p class="uwarn">Excluded non-model audit rows from ${a.map((s)=>s.label).join(", ")}. Those hubs may still use the older request filter, so their 500-row cap can hide model traffic until updated.</p>`:d}
			${this.reasonsTable(e.overall.reasons,"ALL LANES",e.overall.known)}
			${this.modelTable(e.models)}
			${this.laneTable(e.lanes,t.length>0)}
		</div>`}modelTable(e){if(e.length===0)return d;return i`<h3>CACHE BY MODEL</h3>
			<p class="ufoot">partial = some requests have no cache verdict;
				unsupported = declared in machine config; not reported = no provider
				cache field was observed</p>
			<table class="uacts">
				<thead><tr><th>model</th><th class="unum">req</th><th class="unum">verdicts</th><th>warm</th><th class="unum">cache read</th><th>status</th></tr></thead>
				<tbody>${e.map((t)=>i`<tr>
						<td>${t.model}</td><td class="unum">${v(t.requests)}</td>
						<td class="unum">${v(t.known)}</td>
						<td>${t.known>0?z(t.warm_ratio):"—"}</td>
						<td class="unum">${v(t.cache_r_tok)}</td><td>${t.status}</td>
					</tr>`)}</tbody>
			</table>`}filterRow(e){let t=[...new Set(e.lanes.flatMap((s)=>s.models))].sort(),a=[...new Set(e.lanes.flatMap((s)=>s.day_series.map((r)=>r.d)))].sort().reverse();return i`<div class="ufrow">
			<label>
				<span>days</span>
				<select
					@change=${(s)=>{this.days=Number(s.target.value),this.lane="",this.refresh()}}
				>
					${[7,14,28,90].map((s)=>i`<option value=${String(s)} ?selected=${s===this.days}
								>${String(s)}</option
							>`)}
				</select>
			</label>
			<label>
				<span>model</span>
				<select
					@change=${(s)=>{this.model=s.target.value,this.refresh()}}
				>
					${["",...t].map((s)=>i`<option value=${s} ?selected=${s===this.model}
								>${s===""?"any":s}</option
							>`)}
				</select>
			</label>
			<label>
				<span>day</span>
				<select
					@change=${(s)=>{this.day=s.target.value,this.refresh()}}
				>
					${["",...a].map((s)=>i`<option value=${s} ?selected=${s===this.day}
								>${s===""?"all":s}</option
							>`)}
				</select>
			</label>
			<label class="ucheck">
				<input
					type="checkbox"
					?checked=${this.missOnly}
					@change=${(s)=>{this.missOnly=s.target.checked,this.refresh()}}
				/>
				<span>misses only</span>
			</label>
			<span class="uoverall">
				${String(e.overall.requests)} req ·
				${String(e.overall.known)} known · warm
						<b>${e.overall.known>0?z(e.overall.warm_ratio):"—"}</b>
				${this.loading?i`<span class="uempty">· refreshing…</span>`:d}
			</span>
		</div>`}reasonsTable(e,t,a){return i`<h3>MISS REASONS · ${t}</h3>
			${e.length===0?i`<p class="uempty">${a>0?"no cache misses among the requests with reported usage":"no cache verdicts in scope"}</p>`:i`<table class="uacts">
							<thead>
								<tr>
									<th>reason</th>
									<th class="unum">misses</th>
									<th>example rid</th>
									<th>what to do</th>
								</tr>
							</thead>
							<tbody>
								${e.map((s)=>i`<tr>
										<td><b>${s.label}</b></td>
										<td class="unum">${String(s.count)}</td>
										<td class="urid" title=${s.example_rid}>
											${s.example_rid}
										</td>
										<td class="uwhy">${s.detail}</td>
									</tr>`)}
							</tbody>
						</table>`}`}laneTable(e,t){if(e.length===0)return i`<p class="uempty">
				${t?"lane data unavailable from the failed sources":"no requests recorded for this scope"}
			</p>`;let a=Math.max(1,...e.map((s)=>s.requests));return i`<table class="uacts">
			<thead>
				<tr>
					<th>lane</th>
					<th class="unum">req</th>
					<th>warm ratio</th>
					<th class="unum">cache read</th>
					<th class="unum">cache write</th>
					<th>last</th>
				</tr>
			</thead>
			<tbody>
				${e.map((s)=>{let r=s.known>0?s.warm/s.known*100:0;return i`<tr class="ulane">
						<td title=${s.lane}>
							<button class="ulaneButton" type="button" @click=${()=>{this.lane=s.lane,this.refresh()}}>
								<b>${s.models[0]??s.lane}</b>
								${s.models.length>0?i`<span class="ulane-id">${s.lane}</span>`:d}
							</button>
							${s.hubs.map((n)=>i`<span class="uchip">${n}</span>`)}
							${s.models.length>1?i`<span class="uwarn">${String(s.models.length)} models</span>`:d}
						</td>
						<td class="unum">
							${v(s.requests)}
							<span class="ubarslot"
								><i
									class="ureq"
									style=${`width:${String(Math.max(4,s.requests/a*100))}%`}
								></i
							></span>
						</td>
						<td>
							<span class="uwr"
								><i
									class=${r>=50?"uwarm":"ucold"}
									style=${`width:${String(Math.max(2,r))}%`}
									title=${`${z(r/100)} of ${String(s.known)} known`}
								></i
							></span>
							<span class="unum">${s.known>0?z(r/100):"—"}</span>
						</td>
						<td class="unum">${v(s.cache_r_tok)}</td>
						<td class="unum" title=${s.cache_c_known?`${String(s.cache_c_known)} requests reported cache writes`:"Provider did not report cache writes"}>${s.cache_c_known?v(s.cache_c_tok):"—"}</td>
						<td class="unum"><time title=${s.last_ts??"Unknown time"} datetime=${s.last_ts??""}>${ee(s.last_ts)}</time></td>
					</tr>`})}
			</tbody>
		</table>`}scopePanel(e){let t=e.lane_scope;if(t===null)return d;let a=t.requests,s=e.hubs;return i`<div class="upanel">
			<div class="uhead">
				<h2>${t.lane==="(bare ingress)"?"UNATTRIBUTED REQUESTS":`LANE ${t.lane} · REQUESTS`}</h2>
				<button
					class="ubtn"
					@click=${()=>{this.lane="",this.refresh()}}
				>
					← all lanes
				</button>
			</div>
			${this.reasonsTable(t.reasons,t.lane,a.filter((r)=>r.cache_reported===!0||(r.cache_r??0)>0).length)}
			<table class="uacts">
				<thead>
					<tr>
						<th>ts</th>
						<th>model</th>
						<th class="unum">status</th>
						<th class="unum">cache r</th>
						<th class="unum">cache w</th>
						<th class="unum">ms</th>
						<th>hub</th>
					</tr>
				</thead>
				<tbody>
					${a.length===0?i`<tr>
								<td colspan="7" class="uempty">no requests in scope</td>
							</tr>`:a.map((r)=>{let n=s.find((l)=>l.label===r.hub)?.label??r.hub??"";return i`<tr class=${r.ok===!1?"ubad":""}>
					<td class="unum"><time datetime=${r.ts} title=${r.ts}>${ee(r.ts,!0)}</time></td>
									<td>${r.target_model??"—"}</td>
									<td class="unum">${r.status===null?"—":String(r.status)}</td>
									<td class="unum ${r.cache_r===0?"ucoldtext":""}">
										${r.cache_r===null?"—":v(r.cache_r)}
									</td>
									<td class="unum">
										${r.cache_c_reported?v(r.cache_c??0):"—"}
									</td>
									<td class="unum">
										${r.duration_ms===null?"—":v(r.duration_ms)}
									</td>
									<td><span class="uchip">${n}</span></td>
								</tr>`})}
				</tbody>
			</table>
		</div>`}}te.styles=[g`
		:host {
			display: block;
		}
		.upanel {
			display: block;
			background: var(--klh-surface, #1c1b19);
			border: 1px solid var(--klh-edge-soft, rgba(255, 255, 255, 0.08));
			border-radius: 3px;
			padding: 12px 14px 10px;
			margin-bottom: 14px;
		}
		.upanel h2 {
			margin: 0 0 6px;
			font-size: 11px;
			font-weight: 600;
			text-transform: uppercase;
			letter-spacing: 0.08em;
			color: var(--klh-dim, #98958e);
		}
		.uhead {
			display: flex;
			align-items: baseline;
			gap: 12px;
		}
		.uhead .ufoot {
			margin: 0;
		}
		.ufoot {
			font-size: 10.5px;
			color: var(--klh-dim, #98958e);
			margin: 2px 0 8px;
		}
		h3 {
			font-size: 10px;
			font-weight: 600;
			text-transform: uppercase;
			letter-spacing: 0.08em;
			color: var(--klh-dim, #98958e);
			margin: 12px 0 4px;
		}
		table.uacts {
			width: 100%;
			border-collapse: collapse;
			font-size: 12px;
		}
		table.uacts td,
		table.uacts th {
			padding: 6px 8px;
			border-bottom: 1px solid var(--klh-rule, rgba(255, 255, 255, 0.06));
			text-align: left;
		}
		.unum {
			text-align: right;
			font-variant-numeric: tabular-nums;
			color: var(--klh-ink-2, #c9c6bf);
			white-space: nowrap;
		}
		.uchip {
			font-size: 10px;
			color: var(--klh-dim, #98958e);
			border: 1px solid var(--klh-edge, rgba(255, 255, 255, 0.12));
			border-radius: 2px;
			padding: 1px 6px;
			margin-left: 6px;
		}
		.uempty {
			color: var(--klh-dim, #98958e);
			font-size: 12px;
		}
		.uwarn {
			color: var(--klh-danger, #e5484d);
			font-size: 10.5px;
		}
		.ucoldtext {
			color: var(--klh-danger, #e5484d);
		}
		tr.ubad td {
			color: var(--klh-dim, #98958e);
		}
		.ufrow {
			display: flex;
			gap: 14px;
			align-items: center;
			flex-wrap: wrap;
			margin: 6px 0 10px;
			font-size: 11px;
		}
		.ufrow label {
			display: flex;
			gap: 6px;
			align-items: center;
			color: var(--klh-dim, #98958e);
		}
		.ufrow select {
			background: var(--klh-surface, #1c1b19);
			color: var(--klh-ink, #e8e6e1);
			border: 1px solid var(--klh-edge, rgba(255, 255, 255, 0.12));
			border-radius: 2px;
			font: inherit;
			font-size: 11px;
			padding: 2px 4px;
		}
		.uoverall {
			margin-left: auto;
			color: var(--klh-dim, #98958e);
			font-variant-numeric: tabular-nums;
		}
		.uoverall b {
			color: var(--klh-ink, #e8e6e1);
		}
		.ubarslot {
			display: inline-block;
			vertical-align: middle;
			width: 60px;
			margin-left: 6px;
			background: var(--klh-edge-faint, rgba(255, 255, 255, 0.05));
			border-radius: 2px;
			overflow: hidden;
		}
		.ubarslot i.ureq {
			display: block;
			height: 4px;
			background: var(--klh-accent-dim, rgba(216, 144, 15, 0.45));
		}
		.uwr {
			display: inline-block;
			vertical-align: middle;
			width: 80px;
			margin-right: 6px;
			background: var(--klh-edge-faint, rgba(255, 255, 255, 0.05));
			border-radius: 2px;
			overflow: hidden;
		}
		.uwr i {
			display: block;
			height: 8px;
		}
		.uwr i.uwarm {
			background: var(--klh-ok-ink, #3dd68c);
		}
		.uwr i.ucold {
			background: var(--klh-danger, #e5484d);
		}
		tr.ulane {
			cursor: default;
		}
		.ulaneButton {
			background: transparent;
			border: 0;
			padding: 0;
			text-align: left;
			color: inherit;
			font: inherit;
			cursor: pointer;
		}
		.ulaneButton:focus-visible {
			outline: 2px solid var(--klh-accent, #d8900f);
			outline-offset: 2px;
		}
		tr.ulane:hover td {
			background: var(--klh-edge-faint, rgba(255, 255, 255, 0.04));
		}
		.ulane-id {
			display: block;
			color: var(--klh-dim, #98958e);
			font-size: 10px;
			max-width: 34ch;
			overflow: hidden;
			text-overflow: ellipsis;
			white-space: nowrap;
		}
		.urid {
			font-size: 10px;
			color: var(--klh-dim, #98958e);
			max-width: 16ch;
			overflow: hidden;
			text-overflow: ellipsis;
			white-space: nowrap;
		}
		.uwhy {
			font-size: 10.5px;
			color: var(--klh-dim, #98958e);
			max-width: 46ch;
		}
		.ubtn {
			background: transparent;
			color: var(--klh-accent, #d8900f);
			border: 1px solid var(--klh-edge, rgba(255, 255, 255, 0.12));
			border-radius: 2px;
			font: inherit;
			font-size: 11px;
			padding: 2px 8px;
			cursor: pointer;
		}
	`];customElements.define("klh-usage-cache-drill",te);var F=()=>{let e=document.getElementById("usage-data");if(!e)return null;try{return JSON.parse(e.textContent??"")}catch{return null}},f=()=>F()?.panels??null,ae=()=>F()?.slot??{},p=(e)=>e>=1e9?`${(e/1e9).toFixed(1)}B`:e>=1e6?`${(e/1e6).toFixed(1)}M`:e>=1000?`${(e/1000).toFixed(1)}K`:String(Math.round(e)),Ne=(e)=>e==null||!Number.isFinite(e)?"—":p(e),C=(e)=>`${(e*100).toFixed(1)}%`,U=g`
	.upanel {
		display: block;
		background: var(--klh-surface, #1c1b19);
		border: 1px solid var(--klh-edge-soft, rgba(255, 255, 255, 0.08));
		border-radius: 3px;
		padding: 12px 14px 10px;
		margin-bottom: 14px;
	}
	.upanel h2 {
		margin: 0 0 6px;
		font-size: 11px;
		font-weight: 600;
		text-transform: uppercase;
		letter-spacing: 0.08em;
		color: var(--klh-dim, #98958e);
	}
	.uhead {
		display: flex;
		align-items: baseline;
		gap: 12px;
	}
	.uhead .ufoot {
		margin: 0;
	}
	.uempty {
		color: var(--klh-dim, #98958e);
		font-size: 12px;
	}
	.ufoot {
		font-size: 10.5px;
		color: var(--klh-dim, #98958e);
		margin: 2px 0 8px;
	}
	table.uacts {
		width: 100%;
		border-collapse: collapse;
		font-size: 12px;
	}
	table.uacts td,
	table.uacts th {
		padding: 6px 8px;
		border-bottom: 1px solid var(--klh-rule, rgba(255, 255, 255, 0.06));
		text-align: left;
	}
	.unum {
		text-align: right;
		font-variant-numeric: tabular-nums;
		color: var(--klh-ink-2, #c9c6bf);
		white-space: nowrap;
	}
	.uchip {
		font-size: 10px;
		color: var(--klh-dim, #98958e);
		border: 1px solid var(--klh-edge, rgba(255, 255, 255, 0.12));
		border-radius: 2px;
		padding: 1px 6px;
		margin-left: 6px;
	}
	.ubar {
		display: flex;
		height: 12px;
		border-radius: 3px;
		overflow: hidden;
		min-width: 2px;
	}
	.ubar i {
		display: block;
		height: 100%;
	}
	.udot {
		display: inline-block;
		width: 8px;
		height: 8px;
		border-radius: 2px;
		margin-right: 6px;
	}
`;class re extends m{static properties={header:{type:Object,state:!0}};constructor(){super();this.header=null}connectedCallback(){super.connectedCallback(),this.header=f()?.header??null}chips(e,t,a){return i`<span class="ufgroup" data-label=${e}
			>${t.map((s)=>i`<a class="${a}${s.on?" on":""}" href=${s.href}
						>${s.label}</a
					>`)}</span
		>`}body(e){return i`<div class="uback">
				<a href="/">&larr; fleet board</a><span class="uwin">${e.back}</span>
			</div>
			<h1 class="utitle">USAGE</h1>
			<div class="ufilters">
				${this.chips("window",e.windows,"ufilter")}
				${this.chips("team",e.teams,"ufchip")}
				${this.chips("dept",e.depts,"ufchip")}
				${e.filtered?i`<span class="uon">${e.filtered}</span>`:d}
				<span class="uon">${e.status}</span>
			</div>`}render(){return i`${this.header?this.body(this.header):d}`}}re.styles=g`
	:host {
		display: block;
	}
	a {
		color: var(--klh-accent, #d8900f);
	}
	.uback {
		display: flex;
		gap: 16px;
		align-items: baseline;
		margin: 12px 0 0;
	}
	.uwin {
		font-size: 10.5px;
		color: var(--klh-dim, #98958e);
	}
	.utitle {
		font-size: 14px;
		letter-spacing: 0.08em;
		margin: 14px 0 10px;
		color: var(--klh-ink, #e8e6e1);
	}
	.ufilters {
		display: flex;
		gap: 18px;
		align-items: center;
		margin: 0 0 14px;
		flex-wrap: wrap;
	}
	.ufgroup {
		display: flex;
		gap: 6px;
		align-items: center;
	}
	.ufgroup::before {
		content: attr(data-label);
		font-size: 9.5px;
		color: var(--klh-dim, #98958e);
		text-transform: uppercase;
		letter-spacing: 0.06em;
	}
	.ufilter,
	.ufchip {
		font-size: 11px;
		color: var(--klh-dim, #98958e);
		text-decoration: none;
		border: 1px solid var(--klh-edge, rgba(255, 255, 255, 0.12));
		border-radius: 2px;
		padding: 2px 9px;
	}
	.ufilter.on,
	.ufchip.on {
		color: var(--klh-accent, #d8900f);
		border-color: var(--klh-accent, #d8900f);
	}
	.uon {
		font-size: 10.5px;
		color: var(--klh-accent, #d8900f);
	}
`;class ie extends m{static properties={tiles:{type:Array,state:!0}};constructor(){super();this.tiles=[]}connectedCallback(){super.connectedCallback(),this.tiles=f()?.tiles??[]}render(){if(!this.tiles.length)return i``;return i`<div class="utiles">
			${this.tiles.map((e)=>i`<div class="utile">
					<div class="uv">${e.v}</div>
					<div class="uk">${e.k}</div>
				</div>`)}
		</div>`}}ie.styles=g`
	:host {
		display: block;
	}
	.utile {
		flex: 1 1 150px;
		background: var(--klh-surface, #1c1b19);
		border: 1px solid var(--klh-edge-soft, rgba(255, 255, 255, 0.08));
		border-radius: 3px;
		padding: 10px 14px;
	}
	.uv {
		font-size: 22px;
		font-weight: 600;
		color: var(--klh-ink, #e8e6e1);
		font-variant-numeric: tabular-nums;
		word-break: break-all;
	}
	.uk {
		font-size: 10px;
		color: var(--klh-dim, #98958e);
		text-transform: uppercase;
		letter-spacing: 0.06em;
		margin-top: 2px;
	}
	.utiles {
		display: flex;
		gap: 10px;
		flex-wrap: wrap;
		margin: 14px 0;
	}
`;var T=(e,t)=>e[t]??"#888",ne=(e,t,a)=>{let s=e.tok?`${(e.tok/Math.max(1,t)*100).toFixed(2)}%`:"0";return i`<i
		style=${`width:${s};background:${T(a,e.g)}`}
		title=${`${e.g}: ${p(e.tok)} tok`}
	></i>`};class le extends m{static properties={rows:{type:Array,state:!0},query:{type:String,state:!0}};slot={};constructor(){super();this.rows=[],this.query=""}connectedCallback(){super.connectedCallback(),this.rows=f()?.actors?.rows??[],this.slot=ae()}render(){let e=f()?.actors;if(!e?.rows.length)return i`<div class="upanel"><h2>ACTORS</h2><p class="uempty">No actor usage in this window.</p></div>`;return this.body(e.rows)}body(e){let t=this.query.trim().toLocaleLowerCase(),a=t?e.filter((s)=>[s.actor,...s.chips,...s.models.map((r)=>r.m)].some((r)=>r.toLocaleLowerCase().includes(t))):e;return i`<div class="upanel">
			<div class="actor-head">
				<h2>ACTORS · ${String(a.length)} OF ${String(e.length)}</h2>
				<label>Search actor or model
					<input type="search" .value=${this.query}
						@input=${(s)=>{this.query=s.target.value}}
						placeholder="Name, team, or model" />
				</label>
			</div>
			${!a.length?i`<p class="uempty" role="status">No actors match this search.</p>`:d}
			<div class="table-scroll"><table class="uacts">
				<thead>
					<tr>
						<th>actor</th>
						<th style="width:38%">tokens by model group</th>
						<th class="unum">total</th>
						<th class="unum">req</th>
					</tr>
				</thead>
				<tbody>
					${a.map((s)=>this.row(s))}
				</tbody>
			</table></div>
		</div>`}row(e){let t=[...e.demo?["synthetic demo"]:[],...e.chips].map((a)=>i`<span class="uchip">${a}</span>`);return i`<tr class="uact">
				<td>
					<b>${e.actor}</b>
					${t}
				</td>
				<td>
					<div class="ubar" style=${`width:${e.barW}%`}>
						${e.segs.map((a)=>ne(a,e.total,this.slot))}
					</div>
				</td>
				<td class="unum">${p(e.total)}</td>
				<td class="unum">${p(e.rq)}</td>
			</tr>
			${this.detail(e.models)}`}detail(e){return i`<tr class="udetail">
			<td colspan="4">
				<details>
					<summary>per-model</summary>
					<table class="umtab">
						<thead>
							<tr>
								<th>model</th>
								<th class="unum">tokens</th>
								<th class="unum">req</th>
							</tr>
						</thead>
						<tbody>${e.map((t)=>this.mrow(t))}</tbody>
					</table>
				</details>
			</td>
		</tr>`}mrow(e){return i`<tr>
			<td>
				<i
					class="udot"
					style=${`background:${T(this.slot,e.g)}`}
				></i
				>${e.m}
			</td>
			<td class="unum">${p(e.tok)}</td>
			<td class="unum">${p(e.rq)}</td>
		</tr>`}}le.styles=[U,g`
		.actor-head { display:flex; align-items:center; justify-content:space-between; gap:12px; flex-wrap:wrap; margin-bottom:8px; }
		.actor-head h2 { margin:0; }
		.actor-head label { display:flex; align-items:center; gap:8px; color:var(--klh-dim); font-size:11px; }
		.actor-head input { min-width:210px; padding:6px 8px; border:1px solid var(--klh-edge); border-radius:2px; background:var(--klh-bg); color:var(--klh-ink); font:inherit; }
		.actor-head input:focus-visible { outline:2px solid var(--klh-accent); outline-offset:2px; }
		.table-scroll { overflow-x:auto; }
		.table-scroll > table { min-width:560px; }
		@media (max-width:620px) { .actor-head label, .actor-head input { width:100%; } }
		tr.udetail td {
			padding-top: 0;
			border-bottom: none;
		}
		tr.udetail details {
			font-size: 11px;
			color: var(--klh-dim, #98958e);
		}
		tr.udetail summary {
			cursor: pointer;
		}
		table.umtab {
			margin: 6px 0 10px;
			border-collapse: collapse;
		}
		table.umtab td,
		table.umtab th {
			padding: 2px 10px 2px 0;
			font-size: 11px;
			text-align: left;
			color: var(--klh-ink-2, #c9c6bf);
		}
		:host {
			display: block;
		}
	`];class oe extends m{static properties={panel:{type:Object,state:!0}};constructor(){super();this.panel=null}connectedCallback(){super.connectedCallback(),this.panel=f()?.aids??null}render(){let e=this.panel;if(!e)return i``;if(e.empty)return i`<div class="upanel">
				<h2>${e.title}</h2>
				<p class="uempty">${e.empty}</p>
			</div>`;return this.body(e)}body(e){return i`<div class="upanel">
			${e.foot?i`<div class="uhead">
							<h2>${e.title}</h2>
							<p class="ufoot">${e.foot}</p>
						</div>`:i`<h2>${e.title}</h2>`}
			<table class="uacts">
				<thead>
					<tr>
						<th>aid</th>
						<th>domain</th>
						<th class="unum">injected</th>
						<th class="unum">skipped</th>
						<th class="unum">tok injected</th>
					</tr>
				</thead>
				<tbody>${e.rows.map((t)=>this.arow(t))}</tbody>
			</table>
		</div>`}arow(e){return i`<tr>
			<td><b>${e.aid}</b></td>
			<td>${e.domain}</td>
			<td class="unum">${p(e.inj)}</td>
			<td class="unum">${p(e.skip)}</td>
			<td class="unum">${p(e.tok)}</td>
		</tr>`}}oe.styles=[U,g`
		:host {
			display: block;
		}
	`];var se={context:"#3987e5",planning:"#199e70",code:"#d95926",communicating:"#c98500"};class ce extends m{static properties={panel:{type:Object,state:!0}};constructor(){super();this.panel=null}connectedCallback(){super.connectedCallback(),this.panel=f()?.activity??null}render(){let e=this.panel;if(!e)return i``;if("empty"in e)return i`<div class="upanel">
				<h2>WORK MIX</h2>
				<p class="uempty">${e.empty}</p>
			</div>`;return this.body(e)}body(e){let t=[...e.weekly].sort((a,s)=>s.d.localeCompare(a.d))[0];return i`<div class="upanel">
			<div class="uhead">
				<h2>WORK MIX</h2>
				<p class="ufoot">${t?`Week of ${t.d}`:"No weekly data"} · ${e.lanes.length} ${e.lanes.length===1?"lane":"lanes"}</p>
			</div>
			${t?this.mix(t):i`<p class="uempty">No classified activity yet.</p>`}
			<details class="mixdetails">
				<summary>Weekly history and lane breakdown</summary>
				<p class="ufoot">${e.foot}</p>
				${this.weekly(e.weekly)}
				${this.lanes(e.lanes)}
			</details>
		</div>`}mix(e){return i`<div class="mixoverview">
			<div class="mixbar" role="img" aria-label=${e.cells.map((t)=>`${t.key} ${C(t.share)}`).join(", ")}>
				${e.cells.map((t)=>i`<span style=${`width:${C(t.share)};background:${se[t.key]??"#888"}`}></span>`)}
			</div>
			<div class="mixlegend">
				${e.cells.map((t)=>i`<span><i style=${`background:${se[t.key]??"#888"}`}></i>${t.key} <b>${C(t.share)}</b></span>`)}
			</div>
		</div>`}weekly(e){return i`<table class="uacts">
			<thead>
				<tr>
					<th>week</th>
					<th class="unum">cost</th>
					<th>context · planning · code · communicating</th>
					<th class="unum">orient</th>
				</tr>
			</thead>
			<tbody>
				${e.map((t)=>i`<tr>
					<td>${t.d}</td>
					<td class="unum">${p(t.cost)}</td>
					<td style="width:44%">${t.cells.map((a,s)=>this.cell(a,s))}</td>
					<td class="unum">${C(t.orient)}</td>
				</tr>`)}
			</tbody>
		</table>`}cell(e,t){let a=t>0?i`<span class="usep">·</span>`:d;if(!e.share)return i`${a}<span class="uempty">—</span>`;let s=C(e.share);return i`${a}<span class="ucwrap">
			<span class="ubar" style="width:100%"
				><i
					style=${`width:${s};background:${se[e.key]??"#888"}`}
					title=${`${e.key}: ${s}`}
				></i></span
			><span class="unum">${s}</span></span
		>`}lanes(e){let t=e.length?e.map((a)=>this.laneRow(a)):[i`<tr>
						<td colspan="6" class="uempty">
							no classified activity yet — first harvest fills this table
						</td>
					</tr>`];return i`<table class="uacts" style="margin-top:10px">
			<thead>
				<tr>
					<th>lane</th>
					<th>context share</th>
					<th class="unum">orient</th>
					<th class="unum">searches/req</th>
					<th class="unum">cost</th>
					<th class="unum">req</th>
				</tr>
			</thead>
			<tbody>
				${t}
			</tbody>
		</table>`}laneRow(e){return i`<tr>
			<td><b>${e.actor}</b></td>
			<td>${this.cell(e.cells[0],0)}</td>
			<td class="unum">${C(e.orient)}</td>
			<td class="unum">${e.spr}</td>
			<td class="unum">${p(e.cost)}</td>
			<td class="unum">${p(e.req)}</td>
		</tr>`}}ce.styles=[U,g`
		.mixbar { display:flex; height:12px; overflow:hidden; border-radius:3px; background:var(--klh-edge, #555); }
		.mixbar span { display:block; height:100%; }
		.mixlegend { display:flex; flex-wrap:wrap; gap:8px 18px; margin-top:9px; font-size:11px; color:var(--klh-dim, #98958e); }
		.mixlegend span { display:inline-flex; align-items:center; gap:5px; }
		.mixlegend i { display:inline-block; width:7px; height:7px; border-radius:1px; }
		.mixlegend b { color:var(--klh-ink, #eee); font-weight:600; }
		.mixdetails { margin-top:12px; border-top:1px solid var(--klh-edge, #555); padding-top:9px; }
		.mixdetails summary { cursor:pointer; color:var(--klh-ink-2, #ccc); font-size:12px; }
		.mixdetails[open] summary { margin-bottom:10px; }
		.ucwrap {
			display: flex;
			align-items: center;
			gap: 6px;
		}
		.usep {
			color: var(--klh-dim, #98958e);
			margin: 0 4px;
		}
		:host {
			display: block;
		}
	`];var Qe="no spokes reporting — aggregate self-report is opt-in per team (default OFF; the hub policy lists opted-in teams under gateway.federation.self_report.teams)";class de extends m{static properties={panel:{type:Object,state:!0}};slot={};constructor(){super();this.panel=null}connectedCallback(){super.connectedCallback(),this.panel=f()?.spokes??null,this.slot=ae()}render(){let e=f()?.spokes;if(!e)return i``;if(!e.rows.length)return this.empty();return this.body(e.rows)}empty(){return i`<div class="upanel">
			<h2>SPOKES</h2>
			<p class="uempty">${Qe}</p>
		</div>`}body(e){return i`<div class="upanel">
			<h2>SPOKES</h2>
			<table class="uacts">
				<thead>
					<tr>
						<th>spoke</th>
						<th style="width:38%">tokens by model class</th>
						<th class="unum">total</th>
						<th class="unum">req</th>
					</tr>
				</thead>
				<tbody>
					${e.map((t)=>this.row(t))}
				</tbody>
			</table>
		</div>`}row(e){return i`<tr>
			<td>
				<b>${e.spoke}</b>
				<span class="uchip">${e.team}</span>
			</td>
			<td>
				<div class="ubar" style=${`width:${e.barW}%`}>
					${e.segs.map((t)=>ne(t,e.total,this.slot))}
				</div>
			</td>
			<td class="unum">${p(e.total)}</td>
			<td class="unum">${p(e.rq)}</td>
		</tr>`}}de.styles=[U,g`
		:host {
			display: block;
		}
	`];var Xe="no hub rollups — enumerate hubs in stack.yaml (hubs:) or the hubs.json registry; the board fetches each hub's /federation/usage server-side (TTL-cached, per-hub degrade)";class he extends m{static properties={panel:{type:Object,state:!0}};slot={};constructor(){super();this.panel=null}connectedCallback(){super.connectedCallback(),this.panel=f()?.crosshub??null,this.slot=ae()}render(){let e=f()?.crosshub;if(!e)return i``;if("empty"in e)return i`<div class="upanel">
				<h2>CROSS-HUB</h2>
				<p class="uempty">${e.empty}</p>
			</div>`;if(!e.rows.length)return this.empty();return this.body(e.rows)}empty(){return i`<div class="upanel">
			<h2>CROSS-HUB</h2>
			<p class="uempty">${Xe}</p>
		</div>`}row(e){if(e.degraded){let a=e.reason??"No response from this hub",s=/timed out|timeout/i.test(a)?"No response before the hub timeout":/typeerror|host is down|connection refused|unable to connect/i.test(a)?"Cannot reach this hub":/hub answered (401|403)/.test(a)?"Usage access denied":/hub answered 404/.test(a)?"Usage endpoint unavailable":/no url/i.test(a)?"No usage endpoint configured":"Could not read usage from this hub";return i`<tr>
				<td>
					<b>${e.hub}</b>
					<span class="uchip">degraded</span>
				</td>
				<td colspan="3">
					${s}
					<details><summary>Diagnostic</summary><code>${a}</code></details>
				</td>
			</tr>`}let t=Math.max(2,e.total/Math.max(1,...this.rowTotals)*100);return i`<tr>
			<td>
				<b>${e.hub}</b>
				<span class="uchip">${e.via}</span>
				<span class="uchip">${String(e.spokes)} spokes</span>
			</td>
			<td>
				<div class="ubar" style=${`width:${String(t)}%`}>
					${e.segs.map((a)=>ne(a,e.total,this.slot))}
				</div>
			</td>
			<td class="unum">${p(e.total)}</td>
			<td class="unum">${p(e.rq)}</td>
		</tr>`}get rowTotals(){return(f()?.crosshub?.rows??[]).map((e)=>e.total)}body(e){return i`<div class="upanel">
			<h2>CROSS-HUB</h2>
			<table class="uacts">
				<thead>
					<tr>
						<th>hub</th>
						<th style="width:38%">tokens by model class</th>
						<th class="unum">total</th>
						<th class="unum">req</th>
					</tr>
				</thead>
				<tbody>
					${e.map((t)=>this.row(t))}
				</tbody>
			</table>
			<p class="ufoot">${f()?.crosshub?.foot??""}</p>
		</div>`}}he.styles=[U,g`
		:host {
			display: block;
		}
		details {
			margin-top: 4px;
			font-size: 11px;
			color: var(--klh-dim);
		}
		details code {
			overflow-wrap: anywhere;
		}
	`];class ue extends m{static properties={bucket:{type:Number,state:!0},hours:{type:Array,state:!0},report:{type:Object,state:!0},error:{type:String,state:!0},loading:{type:Boolean,state:!0}};dayKey(e){let t=new Date(e),a=(s)=>String(s).padStart(2,"0");return`${String(t.getFullYear())}-${a(t.getMonth()+1)}-${a(t.getDate())}`}dayLabel(e){let[t,a,s]=e.split("-");return`${s}.${a}.${t?.slice(-2)}`}hourLabel(e){return`${String(new Date(e).getHours()).padStart(2,"0")}:00`}requestId=0;constructor(){super();this.bucket=0,this.hours=[],this.report=null,this.error="",this.loading=!1}connectedCallback(){super.connectedCallback();let e=F()?.timeline??[],t=e[0]??[];this.hours=t.map((s,r)=>({bucket:s*1000,tokens:e.slice(1).reduce((n,l)=>n+(l[r]??0),0)})).filter((s)=>s.tokens>0).map((s)=>s.bucket).reverse();let a=Number(new URLSearchParams(location.search).get("hour"));if(this.bucket=this.hours.includes(a)?a:this.hours[0]??0,this.bucket)this.refresh()}refresh(){let e=++this.requestId,t=new URLSearchParams(location.search);t.set("bucket",String(this.bucket)),t.delete("hour"),this.loading=!0,this.error="",fetch(`/api/usage/hour?${t.toString()}`,{signal:AbortSignal.timeout(15000)}).then((a)=>{if(!a.ok)throw Error(`HTTP ${String(a.status)}`);return a.json()}).then((a)=>{if(e!==this.requestId)return;this.report=a.report,this.loading=!1}).catch((a)=>{if(e!==this.requestId)return;this.error=String(a.message??a),this.loading=!1})}selectHour(e){this.bucket=e;let t=new URL(location.href);t.searchParams.set("hour",String(e)),history.replaceState(null,"",t),this.refresh()}render(){if(!this.hours.length)return i``;let e=[...new Set(this.hours.map((r)=>this.dayKey(r)))],t=this.dayKey(this.bucket),a=this.hours.filter((r)=>this.dayKey(r)===t),s=this.report?.actors.flatMap((r)=>r.byModel.map((n)=>({actor:r.actor,...n})))??[];return i`<div class="upanel" id="usage-hour">
			<div class="uhead">
				<h2>HOUR DETAIL</h2>
				<p class="ufoot">Select a day and hour to inspect its actors and models.</p>
			</div>
			<label class="hour-picker">day
				<select
					@change=${(r)=>{let n=r.target.value,l=this.hours.find((o)=>this.dayKey(o)===n);if(l!==void 0)this.selectHour(l)}}
				>
					${e.map((r)=>i`<option value=${r} ?selected=${r===t}>${this.dayLabel(r)}</option>`)}
				</select>
			</label>
			<label class="hour-picker">hour
				<select
					@change=${(r)=>this.selectHour(Number(r.target.value))}
					title=${new Date(this.bucket).toISOString()}
				>
					${a.map((r)=>i`<option value=${String(r)} ?selected=${r===this.bucket} title=${new Date(r).toISOString()}>${this.hourLabel(r)}</option>`)}
				</select>
			</label>
			${this.loading?i`<p class="uempty">Loading hour…</p>`:d}
			${this.error?i`<p class="uempty" role="alert">Hour detail unavailable: ${this.error}</p>`:d}
			${!this.loading&&!this.error&&s.length===0?i`<p class="uempty">No attributed usage in this hour.</p>`:d}
			${!this.loading&&!this.error&&s.length>0?i`<div class="hour-scroll"><table class="uacts">
				<thead><tr><th>actor</th><th>model</th><th>group</th><th>input</th><th>cache read</th><th>cache write</th><th>output</th><th>requests</th></tr></thead>
				<tbody>${s.map((r)=>i`<tr><td>${r.actor}</td><td>${r.model}</td><td>${r.group}</td><td>${p(r.i)}</td><td>${p(r.cr)}</td><td>${p(r.cc)}</td><td>${p(r.o)}</td><td>${String(r.rq)}</td></tr>`)}</tbody>
			</table></div>`:d}
		</div>`}}ue.styles=[U,g`
	.hour-picker { display: flex; align-items: center; gap: 8px; margin: 10px 0; color: var(--klh-dim); font-size: 11px; }
	.hour-picker select { background: var(--klh-surface); color: var(--klh-ink); border: 1px solid var(--klh-edge); padding: 5px; }
	.hour-scroll { overflow-x: auto; }
`];class pe extends m{static properties={tl:{type:String},hours:{type:String}};slot={};groups=[];timeline=[];byHour=[];charts=[];ros=[];resizes=[];onTheme=null;constructor(){super();this.tl="TOKENS · STACKED BY MODEL GROUP",this.hours="WHEN THE FLEET WORKS · HOUR OF DAY (LOCAL)"}connectedCallback(){super.connectedCallback(),this.tl=this.getAttribute("tl")??this.tl,this.hours=this.getAttribute("hours")??this.hours;let e=F();if(this.slot=e?.slot??{},this.groups=e?.groups??[],this.timeline=e?.timeline??[],this.byHour=e?.byHour??[],this.onTheme===null)this.onTheme=()=>{for(let t of this.charts)t.redraw(!1,!0)},document.addEventListener("klh-themechange",this.onTheme)}disconnectedCallback(){super.disconnectedCallback();for(let e of this.ros)e.disconnect();this.ros=[];for(let e of this.resizes)window.removeEventListener("resize",e);if(this.resizes=[],this.onTheme!==null)document.removeEventListener("klh-themechange",this.onTheme),this.onTheme=null}createRenderRoot(){return this}render(){if(!this.timeline.length&&!this.byHour.length)return i``;return i`<div class="usage-chart-grid"><div class="upanel">
				<div class="uhead">
					<h2>${this.tl}</h2>
					<p class="ufoot">hover = values · drag = zoom · double-click = reset</p>
				</div>
				<div class="ulegend">
					${this.groups.map((e)=>i`<span><i style=${`background:${T(this.slot,e)}`}></i
								>${e}</span>`)}
				</div>
				<div id="u-timeline" class="uchart"></div>
			</div>
			<div class="upanel">
				<h2>${this.hours}</h2>
				<div id="u-hours" class="uchart"></div>
			</div></div>`}firstUpdated(){let e=globalThis.uPlot;if(!e)return;let t=(b,c)=>getComputedStyle(document.documentElement).getPropertyValue(b).trim()||c,a=()=>t("--klh-chart-grid","#2c2c2a"),s=()=>t("--klh-chart-hair","#383835"),r=()=>t("--klh-chart-axis","#898781"),n=(b,c)=>c.map((u)=>p(u)),l=(b,c)=>{let u={side:b,...b===3?{size:72}:{},stroke:r,grid:{show:!0,stroke:a,width:1},ticks:{show:!0,stroke:s,width:1}};if(c)u.values=c;return u},o=this.querySelector("#u-timeline");if(o&&this.groups.length){let b=[{}];for(let c of this.groups){let u=T(this.slot,c);b.push({label:c,stacked:!0,stroke:u,fill:u,width:1,points:{show:!1},value:(y,x)=>Ne(x)})}this.chart(o,e,{width:o.clientWidth,height:300,legend:{show:!0,live:!0},scales:{x:{time:!0}},series:b,axes:[l(2),l(3,n)]},this.timeline,300)}let h=this.querySelector("#u-hours");if(h)this.chart(h,e,{width:h.clientWidth,height:190,legend:{show:!1},scales:{x:{time:!1}},series:[{},{label:"tokens",stroke:T(this.slot,"flash"),fill:T(this.slot,"flash"),paths:e.paths?.bars({size:[0.72,100]}),points:{show:!1},value:(b,c)=>Ne(c)}],axes:[l(2,(b,c)=>c.map((u)=>String(Math.round(u)).padStart(2,"0"))),l(3,n)]},this.byHour,190)}chart(e,t,a,s,r){let n=new t(a,s,e);this.charts.push(n);let l=()=>{let o=e.clientWidth;if(o>0&&o!==n.width)n.setSize({width:o,height:r})};if(typeof ResizeObserver==="function"){let o=new ResizeObserver(l);o.observe(e),this.ros.push(o)}else this.resizes.push(l),window.addEventListener("resize",l)}}pe.styles=g`
	:host {
		display: block;
	}
`;customElements.define("klh-usage-header",re);customElements.define("klh-usage-tiles",ie);customElements.define("klh-usage-actors",le);customElements.define("klh-usage-aids",oe);customElements.define("klh-usage-activity",ce);customElements.define("klh-usage-spokes",de);customElements.define("klh-usage-crosshub",he);customElements.define("klh-usage-drilldown",ue);customElements.define("klh-usage-charts",pe);export{ce as KlhUsageActivity,le as KlhUsageActors,oe as KlhUsageAids,pe as KlhUsageCharts,he as KlhUsageCrossHub,ue as KlhUsageDrilldown,re as KlhUsageHeader,de as KlhUsageSpokes,ie as KlhUsageTiles,p as fmtTok,C as pct1};
