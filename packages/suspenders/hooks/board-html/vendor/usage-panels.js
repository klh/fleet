var D=globalThis,j=D.ShadowRoot&&(D.ShadyCSS===void 0||D.ShadyCSS.nativeShadow)&&"adoptedStyleSheets"in Document.prototype&&"replace"in CSSStyleSheet.prototype,K=Symbol(),pe=new WeakMap;class I{constructor(e,t,s){if(this._$cssResult$=!0,s!==K)throw Error("CSSResult is not constructable. Use `unsafeCSS` or `css` instead.");this.cssText=e,this.t=t}get styleSheet(){let e=this.o,t=this.t;if(j&&e===void 0){let s=t!==void 0&&t.length===1;s&&(e=pe.get(t)),e===void 0&&((this.o=e=new CSSStyleSheet).replaceSync(this.cssText),s&&pe.set(t,e))}return e}toString(){return this.cssText}}var me=(e)=>new I(typeof e=="string"?e:e+"",void 0,K),g=(e,...t)=>{let s=e.length===1?e[0]:t.reduce((r,a,l)=>r+((n)=>{if(n._$cssResult$===!0)return n.cssText;if(typeof n=="number")return n;throw Error("Value passed to 'css' function must be a 'css' function result: "+n+". Use 'unsafeCSS' to pass non-literal values, but take care to ensure page security.")})(a)+e[l+1],e[0]);return new I(s,e,K)},ge=(e,t)=>{if(j)e.adoptedStyleSheets=t.map((s)=>s instanceof CSSStyleSheet?s:s.styleSheet);else for(let s of t){let r=document.createElement("style"),a=D.litNonce;a!==void 0&&r.setAttribute("nonce",a),r.textContent=s.cssText,e.appendChild(r)}},V=j?(e)=>e:(e)=>e instanceof CSSStyleSheet?((t)=>{let s="";for(let r of t.cssRules)s+=r.cssText;return me(s)})(e):e;var{is:Le,defineProperty:ze,getOwnPropertyDescriptor:qe,getOwnPropertyNames:De,getOwnPropertySymbols:je,getPrototypeOf:Ie}=Object,B=globalThis,be=B.trustedTypes,Be=be?be.emptyScript:"",We=B.reactiveElementPolyfillSupport,P=(e,t)=>e,G={toAttribute(e,t){switch(t){case Boolean:e=e?Be:null;break;case Object:case Array:e=e==null?e:JSON.stringify(e)}return e},fromAttribute(e,t){let s=e;switch(t){case Boolean:s=e!==null;break;case Number:s=e===null?null:Number(e);break;case Object:case Array:try{s=JSON.parse(e)}catch(r){s=null}}return s}},$e=(e,t)=>!Le(e,t),fe={attribute:!0,type:String,converter:G,reflect:!1,useDefault:!1,hasChanged:$e};Symbol.metadata??=Symbol("metadata"),B.litPropertyMetadata??=new WeakMap;class k extends HTMLElement{static addInitializer(e){this._$Ei(),(this.l??=[]).push(e)}static get observedAttributes(){return this.finalize(),this._$Eh&&[...this._$Eh.keys()]}static createProperty(e,t=fe){if(t.state&&(t.attribute=!1),this._$Ei(),this.prototype.hasOwnProperty(e)&&((t=Object.create(t)).wrapped=!0),this.elementProperties.set(e,t),!t.noAccessor){let s=Symbol(),r=this.getPropertyDescriptor(e,s,t);r!==void 0&&ze(this.prototype,e,r)}}static getPropertyDescriptor(e,t,s){let{get:r,set:a}=qe(this.prototype,e)??{get(){return this[t]},set(l){this[t]=l}};return{get:r,set(l){let n=r?.call(this);a?.call(this,l),this.requestUpdate(e,n,s)},configurable:!0,enumerable:!0}}static getPropertyOptions(e){return this.elementProperties.get(e)??fe}static _$Ei(){if(this.hasOwnProperty(P("elementProperties")))return;let e=Ie(this);e.finalize(),e.l!==void 0&&(this.l=[...e.l]),this.elementProperties=new Map(e.elementProperties)}static finalize(){if(this.hasOwnProperty(P("finalized")))return;if(this.finalized=!0,this._$Ei(),this.hasOwnProperty(P("properties"))){let t=this.properties,s=[...De(t),...je(t)];for(let r of s)this.createProperty(r,t[r])}let e=this[Symbol.metadata];if(e!==null){let t=litPropertyMetadata.get(e);if(t!==void 0)for(let[s,r]of t)this.elementProperties.set(s,r)}this._$Eh=new Map;for(let[t,s]of this.elementProperties){let r=this._$Eu(t,s);r!==void 0&&this._$Eh.set(r,t)}this.elementStyles=this.finalizeStyles(this.styles)}static finalizeStyles(e){let t=[];if(Array.isArray(e)){let s=new Set(e.flat(1/0).reverse());for(let r of s)t.unshift(V(r))}else e!==void 0&&t.push(V(e));return t}static _$Eu(e,t){let s=t.attribute;return s===!1?void 0:typeof s=="string"?s:typeof e=="string"?e.toLowerCase():void 0}constructor(){super(),this._$Ep=void 0,this.isUpdatePending=!1,this.hasUpdated=!1,this._$Em=null,this._$Ev()}_$Ev(){this._$ES=new Promise((e)=>this.enableUpdating=e),this._$AL=new Map,this._$E_(),this.requestUpdate(),this.constructor.l?.forEach((e)=>e(this))}addController(e){(this._$EO??=new Set).add(e),this.renderRoot!==void 0&&this.isConnected&&e.hostConnected?.()}removeController(e){this._$EO?.delete(e)}_$E_(){let e=new Map,t=this.constructor.elementProperties;for(let s of t.keys())this.hasOwnProperty(s)&&(e.set(s,this[s]),delete this[s]);e.size>0&&(this._$Ep=e)}createRenderRoot(){let e=this.shadowRoot??this.attachShadow(this.constructor.shadowRootOptions);return ge(e,this.constructor.elementStyles),e}connectedCallback(){this.renderRoot??=this.createRenderRoot(),this.enableUpdating(!0),this._$EO?.forEach((e)=>e.hostConnected?.())}enableUpdating(e){}disconnectedCallback(){this._$EO?.forEach((e)=>e.hostDisconnected?.())}attributeChangedCallback(e,t,s){this._$AK(e,s)}_$ET(e,t){let s=this.constructor.elementProperties.get(e),r=this.constructor._$Eu(e,s);if(r!==void 0&&s.reflect===!0){let a=(s.converter?.toAttribute!==void 0?s.converter:G).toAttribute(t,s.type);this._$Em=e,a==null?this.removeAttribute(r):this.setAttribute(r,a),this._$Em=null}}_$AK(e,t){let s=this.constructor,r=s._$Eh.get(e);if(r!==void 0&&this._$Em!==r){let a=s.getPropertyOptions(r),l=typeof a.converter=="function"?{fromAttribute:a.converter}:a.converter?.fromAttribute!==void 0?a.converter:G;this._$Em=r;let n=l.fromAttribute(t,a.type);this[r]=n??this._$Ej?.get(r)??n,this._$Em=null}}requestUpdate(e,t,s,r=!1,a){if(e!==void 0){let l=this.constructor;if(r===!1&&(a=this[e]),s??=l.getPropertyOptions(e),!((s.hasChanged??$e)(a,t)||s.useDefault&&s.reflect&&a===this._$Ej?.get(e)&&!this.hasAttribute(l._$Eu(e,s))))return;this.C(e,t,s)}this.isUpdatePending===!1&&(this._$ES=this._$EP())}C(e,t,{useDefault:s,reflect:r,wrapped:a},l){s&&!(this._$Ej??=new Map).has(e)&&(this._$Ej.set(e,l??t??this[e]),a!==!0||l!==void 0)||(this._$AL.has(e)||(this.hasUpdated||s||(t=void 0),this._$AL.set(e,t)),r===!0&&this._$Em!==e&&(this._$Eq??=new Set).add(e))}async _$EP(){this.isUpdatePending=!0;try{await this._$ES}catch(t){Promise.reject(t)}let e=this.scheduleUpdate();return e!=null&&await e,!this.isUpdatePending}scheduleUpdate(){return this.performUpdate()}performUpdate(){if(!this.isUpdatePending)return;if(!this.hasUpdated){if(this.renderRoot??=this.createRenderRoot(),this._$Ep){for(let[r,a]of this._$Ep)this[r]=a;this._$Ep=void 0}let s=this.constructor.elementProperties;if(s.size>0)for(let[r,a]of s){let{wrapped:l}=a,n=this[r];l!==!0||this._$AL.has(r)||n===void 0||this.C(r,void 0,a,n)}}let e=!1,t=this._$AL;try{e=this.shouldUpdate(t),e?(this.willUpdate(t),this._$EO?.forEach((s)=>s.hostUpdate?.()),this.update(t)):this._$EM()}catch(s){throw e=!1,this._$EM(),s}e&&this._$AE(t)}willUpdate(e){}_$AE(e){this._$EO?.forEach((t)=>t.hostUpdated?.()),this.hasUpdated||(this.hasUpdated=!0,this.firstUpdated(e)),this.updated(e)}_$EM(){this._$AL=new Map,this.isUpdatePending=!1}get updateComplete(){return this.getUpdateComplete()}getUpdateComplete(){return this._$ES}shouldUpdate(e){return!0}update(e){this._$Eq&&=this._$Eq.forEach((t)=>this._$ET(t,this[t])),this._$EM()}updated(e){}firstUpdated(e){}}k.elementStyles=[],k.shadowRootOptions={mode:"open"},k[P("elementProperties")]=new Map,k[P("finalized")]=new Map,We?.({ReactiveElement:k}),(B.reactiveElementVersions??=[]).push("2.1.2");var Y=globalThis,ve=(e)=>e,W=Y.trustedTypes,ye=W?W.createPolicy("lit-html",{createHTML:(e)=>e}):void 0;var w=`lit$${Math.random().toFixed(9).slice(2)}$`,Ae="?"+w,Fe=`<${Ae}>`,A=document,O=()=>A.createComment(""),M=(e)=>e===null||typeof e!="object"&&typeof e!="function",J=Array.isArray,Ke=(e)=>J(e)||typeof e?.[Symbol.iterator]=="function";var H=/<(?:(!--|\/[^a-zA-Z])|(\/?[a-zA-Z][^>\s]*)|(\/?$))/g,xe=/-->/g,ke=/>/g,_=RegExp(`>|[ 	
\f\r](?:([^\\s"'>=/]+)([ 	
\f\r]*=[ 	
\f\r]*(?:[^ 	
\f\r"'\`<>=]|("|')|))|$)`,"g"),we=/'/g,_e=/"/g,Ee=/^(?:script|style|textarea|title)$/i,X=(e)=>(t,...s)=>({_$litType$:e,strings:t,values:s}),i=X(1),rt=X(2),at=X(3),E=Symbol.for("lit-noChange"),h=Symbol.for("lit-nothing"),Se=new WeakMap,S=A.createTreeWalker(A,129);function Re(e,t){if(!J(e)||!e.hasOwnProperty("raw"))throw Error("invalid template strings array");return ye!==void 0?ye.createHTML(t):t}var Ve=(e,t)=>{let s=e.length-1,r=[],a,l=t===2?"<svg>":t===3?"<math>":"",n=H;for(let o=0;o<s;o++){let d=e[o],b,c,u=-1,y=0;for(;y<d.length&&(n.lastIndex=y,c=n.exec(d),c!==null);)y=n.lastIndex,n===H?c[1]==="!--"?n=xe:c[1]!==void 0?n=ke:c[2]!==void 0?(Ee.test(c[2])&&(a=RegExp("</"+c[2],"g")),n=_):c[3]!==void 0&&(n=_):n===_?c[0]===">"?(n=a??H,u=-1):c[1]===void 0?u=-2:(u=n.lastIndex-c[2].length,b=c[1],n=c[3]===void 0?_:c[3]==='"'?_e:we):n===_e||n===we?n=_:n===xe||n===ke?n=H:(n=_,a=void 0);let x=n===_&&e[o+1].startsWith("/>")?" ":"";l+=n===H?d+Fe:u>=0?(r.push(b),d.slice(0,u)+"$lit$"+d.slice(u)+w+x):d+w+(u===-2?o:x)}return[Re(e,l+(e[s]||"<?>")+(t===2?"</svg>":t===3?"</math>":"")),r]};class N{constructor({strings:e,_$litType$:t},s){let r;this.parts=[];let a=0,l=0,n=e.length-1,o=this.parts,[d,b]=Ve(e,t);if(this.el=N.createElement(d,s),S.currentNode=this.el.content,t===2||t===3){let c=this.el.content.firstChild;c.replaceWith(...c.childNodes)}for(;(r=S.nextNode())!==null&&o.length<n;){if(r.nodeType===1){if(r.hasAttributes())for(let c of r.getAttributeNames())if(c.endsWith("$lit$")){let u=b[l++],y=r.getAttribute(c).split(w),x=/([.?@])?(.*)/.exec(u);o.push({type:1,index:a,name:x[2],strings:y,ctor:x[1]==="."?Te:x[1]==="?"?Ue:x[1]==="@"?Pe:z}),r.removeAttribute(c)}else c.startsWith(w)&&(o.push({type:6,index:a}),r.removeAttribute(c));if(Ee.test(r.tagName)){let c=r.textContent.split(w),u=c.length-1;if(u>0){r.textContent=W?W.emptyScript:"";for(let y=0;y<u;y++)r.append(c[y],O()),S.nextNode(),o.push({type:2,index:++a});r.append(c[u],O())}}}else if(r.nodeType===8)if(r.data===Ae)o.push({type:2,index:a});else{let c=-1;for(;(c=r.data.indexOf(w,c+1))!==-1;)o.push({type:7,index:a}),c+=w.length-1}a++}}static createElement(e,t){let s=A.createElement("template");return s.innerHTML=e,s}}function R(e,t,s=e,r){if(t===E)return t;let a=r!==void 0?s._$Co?.[r]:s._$Cl,l=M(t)?void 0:t._$litDirective$;return a?.constructor!==l&&(a?._$AO?.(!1),l===void 0?a=void 0:(a=new l(e),a._$AT(e,s,r)),r!==void 0?(s._$Co??=[])[r]=a:s._$Cl=a),a!==void 0&&(t=R(e,a._$AS(e,t.values),a,r)),t}class Ce{constructor(e,t){this._$AV=[],this._$AN=void 0,this._$AD=e,this._$AM=t}get parentNode(){return this._$AM.parentNode}get _$AU(){return this._$AM._$AU}u(e){let{el:{content:t},parts:s}=this._$AD,r=(e?.creationScope??A).importNode(t,!0);S.currentNode=r;let a=S.nextNode(),l=0,n=0,o=s[0];for(;o!==void 0;){if(l===o.index){let d;o.type===2?d=new L(a,a.nextSibling,this,e):o.type===1?d=new o.ctor(a,o.name,o.strings,this,e):o.type===6&&(d=new He(a,this,e)),this._$AV.push(d),o=s[++n]}l!==o?.index&&(a=S.nextNode(),l++)}return S.currentNode=A,r}p(e){let t=0;for(let s of this._$AV)s!==void 0&&(s.strings!==void 0?(s._$AI(e,s,t),t+=s.strings.length-2):s._$AI(e[t])),t++}}class L{get _$AU(){return this._$AM?._$AU??this._$Cv}constructor(e,t,s,r){this.type=2,this._$AH=h,this._$AN=void 0,this._$AA=e,this._$AB=t,this._$AM=s,this.options=r,this._$Cv=r?.isConnected??!0}get parentNode(){let e=this._$AA.parentNode,t=this._$AM;return t!==void 0&&e?.nodeType===11&&(e=t.parentNode),e}get startNode(){return this._$AA}get endNode(){return this._$AB}_$AI(e,t=this){e=R(this,e,t),M(e)?e===h||e==null||e===""?(this._$AH!==h&&this._$AR(),this._$AH=h):e!==this._$AH&&e!==E&&this._(e):e._$litType$!==void 0?this.$(e):e.nodeType!==void 0?this.T(e):Ke(e)?this.k(e):this._(e)}O(e){return this._$AA.parentNode.insertBefore(e,this._$AB)}T(e){this._$AH!==e&&(this._$AR(),this._$AH=this.O(e))}_(e){this._$AH!==h&&M(this._$AH)?this._$AA.nextSibling.data=e:this.T(A.createTextNode(e)),this._$AH=e}$(e){let{values:t,_$litType$:s}=e,r=typeof s=="number"?this._$AC(e):(s.el===void 0&&(s.el=N.createElement(Re(s.h,s.h[0]),this.options)),s);if(this._$AH?._$AD===r)this._$AH.p(t);else{let a=new Ce(r,this),l=a.u(this.options);a.p(t),this.T(l),this._$AH=a}}_$AC(e){let t=Se.get(e.strings);return t===void 0&&Se.set(e.strings,t=new N(e)),t}k(e){J(this._$AH)||(this._$AH=[],this._$AR());let t=this._$AH,s,r=0;for(let a of e)r===t.length?t.push(s=new L(this.O(O()),this.O(O()),this,this.options)):s=t[r],s._$AI(a),r++;r<t.length&&(this._$AR(s&&s._$AB.nextSibling,r),t.length=r)}_$AR(e=this._$AA.nextSibling,t){for(this._$AP?.(!1,!0,t);e!==this._$AB;){let s=ve(e).nextSibling;ve(e).remove(),e=s}}setConnected(e){this._$AM===void 0&&(this._$Cv=e,this._$AP?.(e))}}class z{get tagName(){return this.element.tagName}get _$AU(){return this._$AM._$AU}constructor(e,t,s,r,a){this.type=1,this._$AH=h,this._$AN=void 0,this.element=e,this.name=t,this._$AM=r,this.options=a,s.length>2||s[0]!==""||s[1]!==""?(this._$AH=Array(s.length-1).fill(new String),this.strings=s):this._$AH=h}_$AI(e,t=this,s,r){let a=this.strings,l=!1;if(a===void 0)e=R(this,e,t,0),l=!M(e)||e!==this._$AH&&e!==E,l&&(this._$AH=e);else{let n=e,o,d;for(e=a[0],o=0;o<a.length-1;o++)d=R(this,n[s+o],t,o),d===E&&(d=this._$AH[o]),l||=!M(d)||d!==this._$AH[o],d===h?e=h:e!==h&&(e+=(d??"")+a[o+1]),this._$AH[o]=d}l&&!r&&this.j(e)}j(e){e===h?this.element.removeAttribute(this.name):this.element.setAttribute(this.name,e??"")}}class Te extends z{constructor(){super(...arguments),this.type=3}j(e){this.element[this.name]=e===h?void 0:e}}class Ue extends z{constructor(){super(...arguments),this.type=4}j(e){this.element.toggleAttribute(this.name,!!e&&e!==h)}}class Pe extends z{constructor(e,t,s,r,a){super(e,t,s,r,a),this.type=5}_$AI(e,t=this){if((e=R(this,e,t,0)??h)===E)return;let s=this._$AH,r=e===h&&s!==h||e.capture!==s.capture||e.once!==s.once||e.passive!==s.passive,a=e!==h&&(s===h||r);r&&this.element.removeEventListener(this.name,this,s),a&&this.element.addEventListener(this.name,this,e),this._$AH=e}handleEvent(e){typeof this._$AH=="function"?this._$AH.call(this.options?.host??this.element,e):this._$AH.handleEvent(e)}}class He{constructor(e,t,s){this.element=e,this.type=6,this._$AN=void 0,this._$AM=t,this.options=s}get _$AU(){return this._$AM._$AU}_$AI(e){R(this,e)}}var Ge=Y.litHtmlPolyfillSupport;Ge?.(N,L),(Y.litHtmlVersions??=[]).push("3.3.3");var Oe=(e,t,s)=>{let r=s?.renderBefore??t,a=r._$litPart$;if(a===void 0){let l=s?.renderBefore??null;r._$litPart$=a=new L(t.insertBefore(O(),l),l,void 0,s??{})}return a._$AI(e),a};var Z=globalThis;class m extends k{constructor(){super(...arguments),this.renderOptions={host:this},this._$Do=void 0}createRenderRoot(){let e=super.createRenderRoot();return this.renderOptions.renderBefore??=e.firstChild,e}update(e){let t=this.render();this.hasUpdated||(this.renderOptions.isConnected=this.isConnected),super.update(e),this._$Do=Oe(t,this.renderRoot,this.renderOptions)}connectedCallback(){super.connectedCallback(),this._$Do?.setConnected(!0)}disconnectedCallback(){super.disconnectedCallback(),this._$Do?.setConnected(!1)}render(){return E}}m._$litElement$=!0,m.finalized=!0,Z.litElementHydrateSupport?.({LitElement:m});var Ye=Z.litElementPolyfillSupport;Ye?.({LitElement:m});(Z.litElementVersions??=[]).push("4.2.2");var Je=()=>{let e=document.getElementById("usage-data");if(!e)return null;try{return JSON.parse(e.textContent??"").head??null}catch{return null}};class Q extends m{static properties={head:{type:Object,state:!0}};constructor(){super();this.head=null}connectedCallback(){super.connectedCallback(),this.head=Je()}render(){let e=this.head;if(e===null)return h;return i`<h1 class="utitle">${e.title}</h1>
			<div class="uback">
				<a href=${e.backHref}>&larr; ${e.backLabel}</a>
				<span class=${e.note.kind==="on"?"uon":"uwin"}
					>${e.note.text}</span
				>
			</div>
			<div class="ufilters">
				${e.filters.map((t)=>i`<span class="ufgroup" data-label=${t.label}>
						${t.options.map((s)=>i`<a class=${s.on?"ufilter on":"ufilter"} href=${s.href}
									>${s.label}</a
								>`)}
					</span>`)}
			</div>`}}Q.styles=g`
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
`;customElements.define("klh-usage-head",Q);var f=(e)=>e>=1e9?`${(e/1e9).toFixed(1)}B`:e>=1e6?`${(e/1e6).toFixed(1)}M`:e>=1000?`${(e/1000).toFixed(1)}K`:String(Math.round(e)),q=(e)=>`${(e*100).toFixed(1)}%`,Me=(e)=>e===null||e.length<16?"—":e.slice(11,16);class ee extends m{static properties={report:{type:Object,state:!0},err:{type:String,state:!0},loading:{type:Boolean,state:!0},lane:{type:String,state:!0},days:{type:Number,state:!0},model:{type:String,state:!0},day:{type:String,state:!0},missOnly:{type:Boolean,state:!0}};constructor(){super();this.report=null,this.err="",this.loading=!0,this.lane="",this.days=7,this.model="",this.day="",this.missOnly=!1}connectedCallback(){super.connectedCallback(),this.refresh()}refresh(){let e=new URLSearchParams;if(e.set("days",String(this.days)),this.lane)e.set("lane",this.lane);if(this.model)e.set("model",this.model);if(this.day)e.set("day",this.day);if(this.missOnly)e.set("miss_only","1");this.loading=!0,this.err="",fetch(`/api/usage/cache-drill?${e.toString()}`,{signal:AbortSignal.timeout(15000)}).then((t)=>{if(!t.ok)throw Error(`HTTP ${String(t.status)}`);return t.json()}).then((t)=>{this.report=t,this.loading=!1}).catch((t)=>{this.err=String(t.message??t),this.loading=!1})}render(){if(this.err)return i`<div class="upanel">
				<h2>CACHE EFFICIENCY</h2>
				<p class="uempty">drilldown unavailable — ${this.err}</p>
			</div>`;let e=this.report;if(e===null)return i`<div class="upanel">
				<h2>CACHE EFFICIENCY</h2>
				<p class="uempty">loading…</p>
			</div>`;return i`${this.lanePanel(e)} ${this.scopePanel(e)}`}lanePanel(e){let t=e.hubs.filter((r)=>!r.ok),s=e.hubs.filter((r)=>(r.excluded??0)>0);return i`<div class="upanel">
			<div class="uhead">
				<h2>CACHE EFFICIENCY · WARM RATIO PER LANE</h2>
				<p class="ufoot">
					warm = share of requests that HIT provider cache (cache_read &gt; 0)
					· ${String(e.days)}d window
					${t.length>0?i`· <span class="uwarn"
								>${String(t.length)}/${String(e.hubs.length)} sources
								degraded: ${t.map((r)=>r.label).join(", ")}</span
							>`:h}
				</p>
			</div>
			${this.filterRow(e)}
			${e.overall.requests>e.overall.known?i`<p class="uwarn">Cache verdicts are available for
					${String(e.overall.known)} of ${String(e.overall.requests)}
					requests. Warm rates exclude the rest.</p>`:h}
			${e.probes.requests>0?i`<p class="ufoot">Readiness probes: ${String(e.probes.requests)}
					requests in this window (last ${Me(e.probes.last_ts)}), warm
					${e.probes.known>0?q(e.probes.warm_ratio):"—"} — synthetic
					healthcheck traffic, excluded from the lane and model ratios
					above.</p>`:h}
			${e.local_transcripts&&e.local_transcripts.cache_read_tokens>0?i`<p class="ufoot">Local Claude transcripts report
					${f(e.local_transcripts.cache_read_tokens)} cache-read tokens
					across ${f(e.local_transcripts.requests)} requests in this
					window. This total has no Buckle lane attribution${e.local_transcripts.source==="legacy-aggregate"?" and uses the legacy rollup":""}.</p>`:h}
			${t.length>0?i`<p class="uwarn">Missing request data: ${t.map((r)=>`${r.label} (${r.reason??"unavailable"})`).join(", ")}. Rates cover responding sources only.</p>`:h}
			${e.hubs.some((r)=>r.ok&&(r.rawRows??r.rows)>=500)?i`<p class="uwarn">A source reached the 500-request read limit. Rates cover its newest requests only.</p>`:h}
			${s.length>0?i`<p class="uwarn">Excluded non-model audit rows from ${s.map((r)=>r.label).join(", ")}. Those hubs may still use the older request filter, so their 500-row cap can hide model traffic until updated.</p>`:h}
			${this.reasonsTable(e.overall.reasons,"ALL LANES",e.overall.known)}
			${this.modelTable(e.models)}
			${this.laneTable(e.lanes,t.length>0)}
		</div>`}modelTable(e){if(e.length===0)return h;return i`<h3>CACHE BY MODEL</h3>
			<p class="ufoot">partial = some requests have no cache verdict;
				unsupported = declared in machine config; not reported = no provider
				cache field was observed</p>
			<table class="uacts">
				<thead><tr><th>model</th><th class="unum">req</th><th class="unum">verdicts</th><th>warm</th><th class="unum">cache read</th><th>status</th></tr></thead>
				<tbody>${e.map((t)=>i`<tr>
						<td>${t.model}</td><td class="unum">${f(t.requests)}</td>
						<td class="unum">${f(t.known)}</td>
						<td>${t.known>0?q(t.warm_ratio):"—"}</td>
						<td class="unum">${f(t.cache_r_tok)}</td><td>${t.status}</td>
					</tr>`)}</tbody>
			</table>`}filterRow(e){let t=[...new Set(e.lanes.flatMap((r)=>r.models))].sort(),s=[...new Set(e.lanes.flatMap((r)=>r.day_series.map((a)=>a.d)))].sort().reverse();return i`<div class="ufrow">
			<label>
				<span>days</span>
				<select
					@change=${(r)=>{this.days=Number(r.target.value),this.lane="",this.refresh()}}
				>
					${[7,14,28,90].map((r)=>i`<option value=${String(r)} ?selected=${r===this.days}
								>${String(r)}</option
							>`)}
				</select>
			</label>
			<label>
				<span>model</span>
				<select
					@change=${(r)=>{this.model=r.target.value,this.refresh()}}
				>
					${["",...t].map((r)=>i`<option value=${r} ?selected=${r===this.model}
								>${r===""?"any":r}</option
							>`)}
				</select>
			</label>
			<label>
				<span>day</span>
				<select
					@change=${(r)=>{this.day=r.target.value,this.refresh()}}
				>
					${["",...s].map((r)=>i`<option value=${r} ?selected=${r===this.day}
								>${r===""?"all":r}</option
							>`)}
				</select>
			</label>
			<label class="ucheck">
				<input
					type="checkbox"
					?checked=${this.missOnly}
					@change=${(r)=>{this.missOnly=r.target.checked,this.refresh()}}
				/>
				<span>misses only</span>
			</label>
			<span class="uoverall">
				${String(e.overall.requests)} req ·
				${String(e.overall.known)} known · warm
						<b>${e.overall.known>0?q(e.overall.warm_ratio):"—"}</b>
				${this.loading?i`<span class="uempty">· refreshing…</span>`:h}
			</span>
		</div>`}reasonsTable(e,t,s){return i`<h3>MISS REASONS · ${t}</h3>
			${e.length===0?i`<p class="uempty">${s>0?"no cache misses among the requests with reported usage":"no cache verdicts in scope"}</p>`:i`<table class="uacts">
							<thead>
								<tr>
									<th>reason</th>
									<th class="unum">misses</th>
									<th>example rid</th>
									<th>what to do</th>
								</tr>
							</thead>
							<tbody>
								${e.map((r)=>i`<tr>
										<td><b>${r.label}</b></td>
										<td class="unum">${String(r.count)}</td>
										<td class="urid" title=${r.example_rid}>
											${r.example_rid}
										</td>
										<td class="uwhy">${r.detail}</td>
									</tr>`)}
							</tbody>
						</table>`}`}laneTable(e,t){if(e.length===0)return i`<p class="uempty">
				${t?"lane data unavailable from the failed sources":"no requests recorded for this scope"}
			</p>`;let s=Math.max(1,...e.map((r)=>r.requests));return i`<table class="uacts">
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
				${e.map((r)=>{let a=r.known>0?r.warm/r.known*100:0;return i`<tr
						class="ulane"
						@click=${()=>{this.lane=r.lane==="(bare ingress)"?"":r.lane,this.refresh()}}
					>
						<td title=${r.lane}>
							<b>${r.models[0]??r.lane}</b>
							${r.models.length>0?i`<span class="ulane-id">${r.lane}</span>`:h}
							${r.hubs.map((l)=>i`<span class="uchip">${l}</span>`)}
							${r.models.length>1?i`<span class="uwarn">${String(r.models.length)} models</span>`:h}
						</td>
						<td class="unum">
							${f(r.requests)}
							<span class="ubarslot"
								><i
									class="ureq"
									style=${`width:${String(Math.max(4,r.requests/s*100))}%`}
								></i
							></span>
						</td>
						<td>
							<span class="uwr"
								><i
									class=${a>=50?"uwarm":"ucold"}
									style=${`width:${String(Math.max(2,a))}%`}
									title=${`${q(a/100)} of ${String(r.known)} known`}
								></i
							></span>
							<span class="unum">${r.known>0?q(a/100):"—"}</span>
						</td>
						<td class="unum">${f(r.cache_r_tok)}</td>
						<td class="unum" title=${r.cache_c_known?`${String(r.cache_c_known)} requests reported cache writes`:"Provider did not report cache writes"}>${r.cache_c_known?f(r.cache_c_tok):"—"}</td>
						<td class="unum">${Me(r.last_ts)}</td>
					</tr>`})}
			</tbody>
		</table>`}scopePanel(e){let t=e.lane_scope;if(t===null)return h;let s=t.requests,r=e.hubs;return i`<div class="upanel">
			<div class="uhead">
				<h2>LANE ${t.lane} · REQUESTS</h2>
				<button
					class="ubtn"
					@click=${()=>{this.lane="",this.refresh()}}
				>
					← all lanes
				</button>
			</div>
			${this.reasonsTable(t.reasons,t.lane,s.filter((a)=>a.cache_reported===!0||(a.cache_r??0)>0).length)}
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
					${s.length===0?i`<tr>
								<td colspan="7" class="uempty">no requests in scope</td>
							</tr>`:s.map((a)=>{let l=r.find((n)=>n.label===a.hub)?.label??a.hub??"";return i`<tr class=${a.ok===!1?"ubad":""}>
									<td class="unum">${a.ts.slice(11,19)}</td>
									<td>${a.target_model??"—"}</td>
									<td class="unum">${a.status===null?"—":String(a.status)}</td>
									<td class="unum ${a.cache_r===0?"ucoldtext":""}">
										${a.cache_r===null?"—":f(a.cache_r)}
									</td>
									<td class="unum">
										${a.cache_c_reported?f(a.cache_c??0):"—"}
									</td>
									<td class="unum">
										${a.duration_ms===null?"—":f(a.duration_ms)}
									</td>
									<td><span class="uchip">${l}</span></td>
								</tr>`})}
				</tbody>
			</table>
		</div>`}}ee.styles=[g`
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
			cursor: pointer;
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
	`];customElements.define("klh-usage-cache-drill",ee);var F=()=>{let e=document.getElementById("usage-data");if(!e)return null;try{return JSON.parse(e.textContent??"")}catch{return null}},v=()=>F()?.panels??null,se=()=>F()?.slot??{},p=(e)=>e>=1e9?`${(e/1e9).toFixed(1)}B`:e>=1e6?`${(e/1e6).toFixed(1)}M`:e>=1000?`${(e/1000).toFixed(1)}K`:String(Math.round(e)),Ne=(e)=>e==null||!Number.isFinite(e)?"—":p(e),C=(e)=>`${(e*100).toFixed(1)}%`,U=g`
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
`;class re extends m{static properties={header:{type:Object,state:!0}};constructor(){super();this.header=null}connectedCallback(){super.connectedCallback(),this.header=v()?.header??null}chips(e,t,s){return i`<span class="ufgroup" data-label=${e}
			>${t.map((r)=>i`<a class="${s}${r.on?" on":""}" href=${r.href}
						>${r.label}</a
					>`)}</span
		>`}body(e){return i`<div class="uback">
				<a href="/">&larr; fleet board</a><span class="uwin">${e.back}</span>
			</div>
			<h1 class="utitle">USAGE</h1>
			<div class="ufilters">
				${this.chips("window",e.windows,"ufilter")}
				${this.chips("team",e.teams,"ufchip")}
				${this.chips("dept",e.depts,"ufchip")}
				${e.filtered?i`<span class="uon">${e.filtered}</span>`:h}
				<span class="uon">${e.status}</span>
			</div>`}render(){return i`${this.header?this.body(this.header):h}`}}re.styles=g`
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
`;class ae extends m{static properties={tiles:{type:Array,state:!0}};constructor(){super();this.tiles=[]}connectedCallback(){super.connectedCallback(),this.tiles=v()?.tiles??[]}render(){if(!this.tiles.length)return i``;return i`<div class="utiles">
			${this.tiles.map((e)=>i`<div class="utile">
					<div class="uv">${e.v}</div>
					<div class="uk">${e.k}</div>
				</div>`)}
		</div>`}}ae.styles=g`
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
`;var T=(e,t)=>e[t]??"#888",ie=(e,t,s)=>{let r=e.tok?`${(e.tok/Math.max(1,t)*100).toFixed(2)}%`:"0";return i`<i
		style=${`width:${r};background:${T(s,e.g)}`}
		title=${`${e.g}: ${p(e.tok)} tok`}
	></i>`};class ne extends m{static properties={rows:{type:Array,state:!0}};slot={};constructor(){super();this.rows=[]}connectedCallback(){super.connectedCallback(),this.rows=v()?.actors?.rows??[],this.slot=se()}render(){let e=v()?.actors;if(!e?.rows.length)return i``;return this.body(e.rows)}body(e){return i`<div class="upanel">
			<h2>ACTORS</h2>
			<table class="uacts">
				<thead>
					<tr>
						<th>actor</th>
						<th style="width:38%">tokens by model group</th>
						<th class="unum">total</th>
						<th class="unum">req</th>
					</tr>
				</thead>
				<tbody>
					${e.map((t)=>this.row(t))}
				</tbody>
			</table>
		</div>`}row(e){let t=[...e.demo?["synthetic demo"]:[],...e.chips].map((s)=>i`<span class="uchip">${s}</span>`);return i`<tr class="uact">
				<td>
					<b>${e.actor}</b>
					${t}
				</td>
				<td>
					<div class="ubar" style=${`width:${e.barW}%`}>
						${e.segs.map((s)=>ie(s,e.total,this.slot))}
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
		</tr>`}}ne.styles=[U,g`
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
	`];class le extends m{static properties={panel:{type:Object,state:!0}};constructor(){super();this.panel=null}connectedCallback(){super.connectedCallback(),this.panel=v()?.aids??null}render(){let e=this.panel;if(!e)return i``;if(e.empty)return i`<div class="upanel">
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
		</tr>`}}le.styles=[U,g`
		:host {
			display: block;
		}
	`];var te={context:"#3987e5",planning:"#199e70",code:"#d95926",communicating:"#c98500"};class oe extends m{static properties={panel:{type:Object,state:!0}};constructor(){super();this.panel=null}connectedCallback(){super.connectedCallback(),this.panel=v()?.activity??null}render(){let e=this.panel;if(!e)return i``;if("empty"in e)return i`<div class="upanel">
				<h2>WORK MIX</h2>
				<p class="uempty">${e.empty}</p>
			</div>`;return this.body(e)}body(e){let t=[...e.weekly].sort((s,r)=>r.d.localeCompare(s.d))[0];return i`<div class="upanel">
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
				${e.cells.map((t)=>i`<span style=${`width:${C(t.share)};background:${te[t.key]??"#888"}`}></span>`)}
			</div>
			<div class="mixlegend">
				${e.cells.map((t)=>i`<span><i style=${`background:${te[t.key]??"#888"}`}></i>${t.key} <b>${C(t.share)}</b></span>`)}
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
					<td style="width:44%">${t.cells.map((s,r)=>this.cell(s,r))}</td>
					<td class="unum">${C(t.orient)}</td>
				</tr>`)}
			</tbody>
		</table>`}cell(e,t){let s=t>0?i`<span class="usep">·</span>`:h;if(!e.share)return i`${s}<span class="uempty">—</span>`;let r=C(e.share);return i`${s}<span class="ucwrap">
			<span class="ubar" style="width:100%"
				><i
					style=${`width:${r};background:${te[e.key]??"#888"}`}
					title=${`${e.key}: ${r}`}
				></i></span
			><span class="unum">${r}</span></span
		>`}lanes(e){let t=e.length?e.map((s)=>this.laneRow(s)):[i`<tr>
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
		</tr>`}}oe.styles=[U,g`
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
	`];var Xe="no spokes reporting — aggregate self-report is opt-in per team (default OFF; the hub policy lists opted-in teams under gateway.federation.self_report.teams)";class ce extends m{static properties={panel:{type:Object,state:!0}};slot={};constructor(){super();this.panel=null}connectedCallback(){super.connectedCallback(),this.panel=v()?.spokes??null,this.slot=se()}render(){let e=v()?.spokes;if(!e)return i``;if(!e.rows.length)return this.empty();return this.body(e.rows)}empty(){return i`<div class="upanel">
			<h2>SPOKES</h2>
			<p class="uempty">${Xe}</p>
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
					${e.segs.map((t)=>ie(t,e.total,this.slot))}
				</div>
			</td>
			<td class="unum">${p(e.total)}</td>
			<td class="unum">${p(e.rq)}</td>
		</tr>`}}ce.styles=[U,g`
		:host {
			display: block;
		}
	`];var Ze="no hub rollups — enumerate hubs in stack.yaml (hubs:) or the hubs.json registry; the board fetches each hub's /federation/usage server-side (TTL-cached, per-hub degrade)";class he extends m{static properties={panel:{type:Object,state:!0}};slot={};constructor(){super();this.panel=null}connectedCallback(){super.connectedCallback(),this.panel=v()?.crosshub??null,this.slot=se()}render(){let e=v()?.crosshub;if(!e)return i``;if("empty"in e)return i`<div class="upanel">
				<h2>CROSS-HUB</h2>
				<p class="uempty">${e.empty}</p>
			</div>`;if(!e.rows.length)return this.empty();return this.body(e.rows)}empty(){return i`<div class="upanel">
			<h2>CROSS-HUB</h2>
			<p class="uempty">${Ze}</p>
		</div>`}row(e){if(e.degraded)return i`<tr>
				<td>
					<b>${e.hub}</b>
					<span class="uchip">degraded</span>
				</td>
				<td colspan="3">${e.reason??"hub down"}</td>
			</tr>`;let t=Math.max(2,e.total/Math.max(1,...this.rowTotals)*100);return i`<tr>
			<td>
				<b>${e.hub}</b>
				<span class="uchip">${e.via}</span>
				<span class="uchip">${String(e.spokes)} spokes</span>
			</td>
			<td>
				<div class="ubar" style=${`width:${String(t)}%`}>
					${e.segs.map((s)=>ie(s,e.total,this.slot))}
				</div>
			</td>
			<td class="unum">${p(e.total)}</td>
			<td class="unum">${p(e.rq)}</td>
		</tr>`}get rowTotals(){return(v()?.crosshub?.rows??[]).map((e)=>e.total)}body(e){return i`<div class="upanel">
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
		</div>`}}he.styles=[U,g`
		:host {
			display: block;
		}
	`];class de extends m{static properties={bucket:{type:Number,state:!0},hours:{type:Array,state:!0},report:{type:Object,state:!0},error:{type:String,state:!0},loading:{type:Boolean,state:!0}};stamp(e){let t=new Date(e),s=(o)=>String(o).padStart(2,"0"),r=-t.getTimezoneOffset(),a=Math.abs(r),l=`${s(t.getUTCMonth()+1)}-${s(t.getUTCDate())} ${s(t.getUTCHours())}:00Z`,n=`${s(t.getHours())}:${s(t.getMinutes())} UTC${r>=0?"+":"-"}${s(Math.floor(a/60))}:${s(a%60)}`;return`${l} (${n})`}requestId=0;constructor(){super();this.bucket=0,this.hours=[],this.report=null,this.error="",this.loading=!1}connectedCallback(){super.connectedCallback();let e=F()?.timeline??[],t=e[0]??[];this.hours=t.map((r,a)=>({bucket:r*1000,tokens:e.slice(1).reduce((l,n)=>l+(n[a]??0),0)})).filter((r)=>r.tokens>0).map((r)=>r.bucket).reverse();let s=Number(new URLSearchParams(location.search).get("hour"));if(this.bucket=this.hours.includes(s)?s:this.hours[0]??0,this.bucket)this.refresh()}refresh(){let e=++this.requestId,t=new URLSearchParams(location.search);t.set("bucket",String(this.bucket)),t.delete("hour"),this.loading=!0,this.error="",fetch(`/api/usage/hour?${t.toString()}`,{signal:AbortSignal.timeout(15000)}).then((s)=>{if(!s.ok)throw Error(`HTTP ${String(s.status)}`);return s.json()}).then((s)=>{if(e!==this.requestId)return;this.report=s.report,this.loading=!1}).catch((s)=>{if(e!==this.requestId)return;this.error=String(s.message??s),this.loading=!1})}render(){if(!this.hours.length)return i``;let e=this.report?.actors.flatMap((t)=>t.byModel.map((s)=>({actor:t.actor,...s})))??[];return i`<div class="upanel" id="usage-hour">
			<div class="uhead">
				<h2>HOUR DETAIL</h2>
				<p class="ufoot">Select an hour to inspect its actors and models.</p>
			</div>
			<label class="hour-picker">hour
				<select
					@change=${(t)=>{this.bucket=Number(t.target.value);let s=new URL(location.href);s.searchParams.set("hour",String(this.bucket)),history.replaceState(null,"",s),this.refresh()}}
				>
					${this.hours.map((t)=>i`<option value=${String(t)} ?selected=${t===this.bucket}>${this.stamp(t)}</option>`)}
				</select>
			</label>
			${this.loading?i`<p class="uempty">Loading hour…</p>`:h}
			${this.error?i`<p class="uempty" role="alert">Hour detail unavailable: ${this.error}</p>`:h}
			${!this.loading&&!this.error&&e.length===0?i`<p class="uempty">No attributed usage in this hour.</p>`:h}
			${!this.loading&&!this.error&&e.length>0?i`<div class="hour-scroll"><table class="uacts">
				<thead><tr><th>actor</th><th>model</th><th>group</th><th>input</th><th>cache read</th><th>cache write</th><th>output</th><th>requests</th></tr></thead>
				<tbody>${e.map((t)=>i`<tr><td>${t.actor}</td><td>${t.model}</td><td>${t.group}</td><td>${p(t.i)}</td><td>${p(t.cr)}</td><td>${p(t.cc)}</td><td>${p(t.o)}</td><td>${String(t.rq)}</td></tr>`)}</tbody>
			</table></div>`:h}
		</div>`}}de.styles=[U,g`
	.hour-picker { display: flex; align-items: center; gap: 8px; margin: 10px 0; color: var(--klh-dim); font-size: 11px; }
	.hour-picker select { background: var(--klh-surface); color: var(--klh-ink); border: 1px solid var(--klh-edge); padding: 5px; }
	.hour-scroll { overflow-x: auto; }
`];class ue extends m{static properties={tl:{type:String},hours:{type:String}};slot={};groups=[];timeline=[];byHour=[];charts=[];ros=[];resizes=[];onTheme=null;constructor(){super();this.tl="TOKENS · STACKED BY MODEL GROUP",this.hours="WHEN THE FLEET WORKS · HOUR OF DAY (LOCAL)"}connectedCallback(){super.connectedCallback(),this.tl=this.getAttribute("tl")??this.tl,this.hours=this.getAttribute("hours")??this.hours;let e=F();if(this.slot=e?.slot??{},this.groups=e?.groups??[],this.timeline=e?.timeline??[],this.byHour=e?.byHour??[],this.onTheme===null)this.onTheme=()=>{for(let t of this.charts)t.redraw(!1,!0)},document.addEventListener("klh-themechange",this.onTheme)}disconnectedCallback(){super.disconnectedCallback();for(let e of this.ros)e.disconnect();this.ros=[];for(let e of this.resizes)window.removeEventListener("resize",e);if(this.resizes=[],this.onTheme!==null)document.removeEventListener("klh-themechange",this.onTheme),this.onTheme=null}createRenderRoot(){return this}render(){if(!this.timeline.length&&!this.byHour.length)return i``;return i`<div class="upanel">
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
			</div>`}firstUpdated(){let e=globalThis.uPlot;if(!e)return;let t=(b,c)=>getComputedStyle(document.documentElement).getPropertyValue(b).trim()||c,s=()=>t("--klh-chart-grid","#2c2c2a"),r=()=>t("--klh-chart-hair","#383835"),a=()=>t("--klh-chart-axis","#898781"),l=(b,c)=>c.map((u)=>p(u)),n=(b,c)=>{let u={side:b,...b===3?{size:72}:{},stroke:a,grid:{show:!0,stroke:s,width:1},ticks:{show:!0,stroke:r,width:1}};if(c)u.values=c;return u},o=this.querySelector("#u-timeline");if(o&&this.groups.length){let b=[{}];for(let c of this.groups){let u=T(this.slot,c);b.push({label:c,stacked:!0,stroke:u,fill:u,width:1,points:{show:!1},value:(y,x)=>Ne(x)})}this.chart(o,e,{width:o.clientWidth,height:300,legend:{show:!0,live:!0},scales:{x:{time:!0}},series:b,axes:[n(2),n(3,l)]},this.timeline,300)}let d=this.querySelector("#u-hours");if(d)this.chart(d,e,{width:d.clientWidth,height:190,legend:{show:!1},scales:{x:{time:!1}},series:[{},{label:"tokens",stroke:T(this.slot,"flash"),fill:T(this.slot,"flash"),paths:e.paths?.bars({size:[0.72,100]}),points:{show:!1},value:(b,c)=>Ne(c)}],axes:[n(2,(b,c)=>c.map((u)=>String(Math.round(u)).padStart(2,"0"))),n(3,l)]},this.byHour,190)}chart(e,t,s,r,a){let l=new t(s,r,e);this.charts.push(l);let n=()=>{let o=e.clientWidth;if(o>0&&o!==l.width)l.setSize({width:o,height:a})};if(typeof ResizeObserver==="function"){let o=new ResizeObserver(n);o.observe(e),this.ros.push(o)}else this.resizes.push(n),window.addEventListener("resize",n)}}ue.styles=g`
	:host {
		display: block;
	}
`;customElements.define("klh-usage-header",re);customElements.define("klh-usage-tiles",ae);customElements.define("klh-usage-actors",ne);customElements.define("klh-usage-aids",le);customElements.define("klh-usage-activity",oe);customElements.define("klh-usage-spokes",ce);customElements.define("klh-usage-crosshub",he);customElements.define("klh-usage-drilldown",de);customElements.define("klh-usage-charts",ue);export{oe as KlhUsageActivity,ne as KlhUsageActors,le as KlhUsageAids,ue as KlhUsageCharts,he as KlhUsageCrossHub,de as KlhUsageDrilldown,re as KlhUsageHeader,ce as KlhUsageSpokes,ae as KlhUsageTiles,p as fmtTok,C as pct1};
