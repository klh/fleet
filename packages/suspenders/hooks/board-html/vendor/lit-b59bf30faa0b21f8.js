// Vendored from the Lit monorepo (lit, lit-html, lit-element, @lit/reactive-element) — BSD-3-Clause License (https://github.com/lit/lit); bundled offline.
<<<<<<< HEAD:packages/suspenders/hooks/board-html/vendor/lit-b59bf30faa0b21f8.js
var H=globalThis,L=H.ShadowRoot&&(H.ShadyCSS===void 0||H.ShadyCSS.nativeShadow)&&"adoptedStyleSheets"in Document.prototype&&"replace"in CSSStyleSheet.prototype,B=Symbol(),F=new WeakMap;class D{constructor(s,i,o){if(this._$cssResult$=!0,o!==B)throw Error("CSSResult is not constructable. Use `unsafeCSS` or `css` instead.");this.cssText=s,this.t=i}get styleSheet(){let s=this.o,i=this.t;if(L&&s===void 0){let o=i!==void 0&&i.length===1;o&&(s=F.get(i)),s===void 0&&((this.o=s=new CSSStyleSheet).replaceSync(this.cssText),o&&F.set(i,s))}return s}toString(){return this.cssText}}var h=(s)=>new D(typeof s=="string"?s:s+"",void 0,B),r=(s,...i)=>{let o=s.length===1?s[0]:i.reduce((a,l,p)=>a+((c)=>{if(c._$cssResult$===!0)return c.cssText;if(typeof c=="number")return c;throw Error("Value passed to 'css' function must be a 'css' function result: "+c+". Use 'unsafeCSS' to pass non-literal values, but take care to ensure page security.")})(l)+s[p+1],s[0]);return new D(o,s,B)},J=(s,i)=>{if(L)s.adoptedStyleSheets=i.map((o)=>o instanceof CSSStyleSheet?o:o.styleSheet);else for(let o of i){let a=document.createElement("style"),l=H.litNonce;l!==void 0&&a.setAttribute("nonce",l),a.textContent=o.cssText,s.appendChild(a)}},z=L?(s)=>s:(s)=>s instanceof CSSStyleSheet?((i)=>{let o="";for(let a of i.cssRules)o+=a.cssText;return h(o)})(s):s;var{is:$t,defineProperty:_t,getOwnPropertyDescriptor:ft,getOwnPropertyNames:At,getOwnPropertySymbols:mt,getPrototypeOf:gt}=Object,j=globalThis,Z=j.trustedTypes,yt=Z?Z.emptyScript:"",vt=j.reactiveElementPolyfillSupport,x=(s,i)=>s,I={toAttribute(s,i){switch(i){case Boolean:s=s?yt:null;break;case Object:case Array:s=s==null?s:JSON.stringify(s)}return s},fromAttribute(s,i){let o=s;switch(i){case Boolean:o=s!==null;break;case Number:o=s===null?null:Number(s);break;case Object:case Array:try{o=JSON.parse(s)}catch(a){o=null}}return o}},Q=(s,i)=>!$t(s,i),G={attribute:!0,type:String,converter:I,reflect:!1,useDefault:!1,hasChanged:Q};Symbol.metadata??=Symbol("metadata"),j.litPropertyMetadata??=new WeakMap;class m extends HTMLElement{static addInitializer(s){this._$Ei(),(this.l??=[]).push(s)}static get observedAttributes(){return this.finalize(),this._$Eh&&[...this._$Eh.keys()]}static createProperty(s,i=G){if(i.state&&(i.attribute=!1),this._$Ei(),this.prototype.hasOwnProperty(s)&&((i=Object.create(i)).wrapped=!0),this.elementProperties.set(s,i),!i.noAccessor){let o=Symbol(),a=this.getPropertyDescriptor(s,o,i);a!==void 0&&_t(this.prototype,s,a)}}static getPropertyDescriptor(s,i,o){let{get:a,set:l}=ft(this.prototype,s)??{get(){return this[i]},set(p){this[i]=p}};return{get:a,set(p){let c=a?.call(this);l?.call(this,p),this.requestUpdate(s,c,o)},configurable:!0,enumerable:!0}}static getPropertyOptions(s){return this.elementProperties.get(s)??G}static _$Ei(){if(this.hasOwnProperty(x("elementProperties")))return;let s=gt(this);s.finalize(),s.l!==void 0&&(this.l=[...s.l]),this.elementProperties=new Map(s.elementProperties)}static finalize(){if(this.hasOwnProperty(x("finalized")))return;if(this.finalized=!0,this._$Ei(),this.hasOwnProperty(x("properties"))){let i=this.properties,o=[...At(i),...mt(i)];for(let a of o)this.createProperty(a,i[a])}let s=this[Symbol.metadata];if(s!==null){let i=litPropertyMetadata.get(s);if(i!==void 0)for(let[o,a]of i)this.elementProperties.set(o,a)}this._$Eh=new Map;for(let[i,o]of this.elementProperties){let a=this._$Eu(i,o);a!==void 0&&this._$Eh.set(a,i)}this.elementStyles=this.finalizeStyles(this.styles)}static finalizeStyles(s){let i=[];if(Array.isArray(s)){let o=new Set(s.flat(1/0).reverse());for(let a of o)i.unshift(z(a))}else s!==void 0&&i.push(z(s));return i}static _$Eu(s,i){let o=i.attribute;return o===!1?void 0:typeof o=="string"?o:typeof s=="string"?s.toLowerCase():void 0}constructor(){super(),this._$Ep=void 0,this.isUpdatePending=!1,this.hasUpdated=!1,this._$Em=null,this._$Ev()}_$Ev(){this._$ES=new Promise((s)=>this.enableUpdating=s),this._$AL=new Map,this._$E_(),this.requestUpdate(),this.constructor.l?.forEach((s)=>s(this))}addController(s){(this._$EO??=new Set).add(s),this.renderRoot!==void 0&&this.isConnected&&s.hostConnected?.()}removeController(s){this._$EO?.delete(s)}_$E_(){let s=new Map,i=this.constructor.elementProperties;for(let o of i.keys())this.hasOwnProperty(o)&&(s.set(o,this[o]),delete this[o]);s.size>0&&(this._$Ep=s)}createRenderRoot(){let s=this.shadowRoot??this.attachShadow(this.constructor.shadowRootOptions);return J(s,this.constructor.elementStyles),s}connectedCallback(){this.renderRoot??=this.createRenderRoot(),this.enableUpdating(!0),this._$EO?.forEach((s)=>s.hostConnected?.())}enableUpdating(s){}disconnectedCallback(){this._$EO?.forEach((s)=>s.hostDisconnected?.())}attributeChangedCallback(s,i,o){this._$AK(s,o)}_$ET(s,i){let o=this.constructor.elementProperties.get(s),a=this.constructor._$Eu(s,o);if(a!==void 0&&o.reflect===!0){let l=(o.converter?.toAttribute!==void 0?o.converter:I).toAttribute(i,o.type);this._$Em=s,l==null?this.removeAttribute(a):this.setAttribute(a,l),this._$Em=null}}_$AK(s,i){let o=this.constructor,a=o._$Eh.get(s);if(a!==void 0&&this._$Em!==a){let l=o.getPropertyOptions(a),p=typeof l.converter=="function"?{fromAttribute:l.converter}:l.converter?.fromAttribute!==void 0?l.converter:I;this._$Em=a;let c=p.fromAttribute(i,l.type);this[a]=c??this._$Ej?.get(a)??c,this._$Em=null}}requestUpdate(s,i,o,a=!1,l){if(s!==void 0){let p=this.constructor;if(a===!1&&(l=this[s]),o??=p.getPropertyOptions(s),!((o.hasChanged??Q)(l,i)||o.useDefault&&o.reflect&&l===this._$Ej?.get(s)&&!this.hasAttribute(p._$Eu(s,o))))return;this.C(s,i,o)}this.isUpdatePending===!1&&(this._$ES=this._$EP())}C(s,i,{useDefault:o,reflect:a,wrapped:l},p){o&&!(this._$Ej??=new Map).has(s)&&(this._$Ej.set(s,p??i??this[s]),l!==!0||p!==void 0)||(this._$AL.has(s)||(this.hasUpdated||o||(i=void 0),this._$AL.set(s,i)),a===!0&&this._$Em!==s&&(this._$Eq??=new Set).add(s))}async _$EP(){this.isUpdatePending=!0;try{await this._$ES}catch(i){Promise.reject(i)}let s=this.scheduleUpdate();return s!=null&&await s,!this.isUpdatePending}scheduleUpdate(){return this.performUpdate()}performUpdate(){if(!this.isUpdatePending)return;if(!this.hasUpdated){if(this.renderRoot??=this.createRenderRoot(),this._$Ep){for(let[a,l]of this._$Ep)this[a]=l;this._$Ep=void 0}let o=this.constructor.elementProperties;if(o.size>0)for(let[a,l]of o){let{wrapped:p}=l,c=this[a];p!==!0||this._$AL.has(a)||c===void 0||this.C(a,void 0,l,c)}}let s=!1,i=this._$AL;try{s=this.shouldUpdate(i),s?(this.willUpdate(i),this._$EO?.forEach((o)=>o.hostUpdate?.()),this.update(i)):this._$EM()}catch(o){throw s=!1,this._$EM(),o}s&&this._$AE(i)}willUpdate(s){}_$AE(s){this._$EO?.forEach((i)=>i.hostUpdated?.()),this.hasUpdated||(this.hasUpdated=!0,this.firstUpdated(s)),this.updated(s)}_$EM(){this._$AL=new Map,this.isUpdatePending=!1}get updateComplete(){return this.getUpdateComplete()}getUpdateComplete(){return this._$ES}shouldUpdate(s){return!0}update(s){this._$Eq&&=this._$Eq.forEach((i)=>this._$ET(i,this[i])),this._$EM()}updated(s){}firstUpdated(s){}}m.elementStyles=[],m.shadowRootOptions={mode:"open"},m[x("elementProperties")]=new Map,m[x("finalized")]=new Map,vt?.({ReactiveElement:m}),(j.reactiveElementVersions??=[]).push("2.1.2");var V=globalThis,X=(s)=>s,k=V.trustedTypes,Y=k?k.createPolicy("lit-html",{createHTML:(s)=>s}):void 0;var g=`lit$${Math.random().toFixed(9).slice(2)}$`,ot="?"+g,St=`<${ot}>`,b=document,U=()=>b.createComment(""),O=(s)=>s===null||typeof s!="object"&&typeof s!="function",W=Array.isArray,Et=(s)=>W(s)||typeof s?.[Symbol.iterator]=="function";var P=/<(?:(!--|\/[^a-zA-Z])|(\/?[a-zA-Z][^>\s]*)|(\/?$))/g,tt=/-->/g,et=/>/g,v=RegExp(`>|[ 	
\f\r](?:([^\\s"'>=/]+)([ 	
\f\r]*=[ 	
\f\r]*(?:[^ 	
\f\r"'\`<>=]|("|')|))|$)`,"g"),st=/'/g,it=/"/g,nt=/^(?:script|style|textarea|title)$/i,q=(s)=>(i,...o)=>({_$litType$:s,strings:i,values:o}),e=q(1),E=q(2),Mt=q(3),C=Symbol.for("lit-noChange"),t=Symbol.for("lit-nothing"),rt=new WeakMap,S=b.createTreeWalker(b,129);function ht(s,i){if(!W(s)||!s.hasOwnProperty("raw"))throw Error("invalid template strings array");return Y!==void 0?Y.createHTML(i):i}var bt=(s,i)=>{let o=s.length-1,a=[],l,p=i===2?"<svg>":i===3?"<math>":"",c=P;for(let d=0;d<o;d++){let _=s[d],R,u,f=-1,A=0;for(;A<_.length&&(c.lastIndex=A,u=c.exec(_),u!==null);)A=c.lastIndex,c===P?u[1]==="!--"?c=tt:u[1]!==void 0?c=et:u[2]!==void 0?(nt.test(u[2])&&(l=RegExp("</"+u[2],"g")),c=v):u[3]!==void 0&&(c=v):c===v?u[0]===">"?(c=l??P,f=-1):u[1]===void 0?f=-2:(f=c.lastIndex-u[2].length,R=u[1],c=u[3]===void 0?v:u[3]==='"'?it:st):c===it||c===st?c=v:c===tt||c===et?c=P:(c=v,l=void 0);let y=c===v&&s[d+1].startsWith("/>")?" ":"";p+=c===P?_+St:f>=0?(a.push(R),_.slice(0,f)+"$lit$"+_.slice(f)+g+y):_+g+(f===-2?d:y)}return[ht(s,p+(s[o]||"<?>")+(i===2?"</svg>":i===3?"</math>":"")),a]};class M{constructor({strings:s,_$litType$:i},o){let a;this.parts=[];let l=0,p=0,c=s.length-1,d=this.parts,[_,R]=bt(s,i);if(this.el=M.createElement(_,o),S.currentNode=this.el.content,i===2||i===3){let u=this.el.content.firstChild;u.replaceWith(...u.childNodes)}for(;(a=S.nextNode())!==null&&d.length<c;){if(a.nodeType===1){if(a.hasAttributes())for(let u of a.getAttributeNames())if(u.endsWith("$lit$")){let f=R[p++],A=a.getAttribute(u).split(g),y=/([.?@])?(.*)/.exec(f);d.push({type:1,index:l,name:y[2],strings:A,ctor:y[1]==="."?lt:y[1]==="?"?ct:y[1]==="@"?pt:T}),a.removeAttribute(u)}else u.startsWith(g)&&(d.push({type:6,index:l}),a.removeAttribute(u));if(nt.test(a.tagName)){let u=a.textContent.split(g),f=u.length-1;if(f>0){a.textContent=k?k.emptyScript:"";for(let A=0;A<f;A++)a.append(u[A],U()),S.nextNode(),d.push({type:2,index:++l});a.append(u[f],U())}}}else if(a.nodeType===8)if(a.data===ot)d.push({type:2,index:l});else{let u=-1;for(;(u=a.data.indexOf(g,u+1))!==-1;)d.push({type:7,index:l}),u+=g.length-1}l++}}static createElement(s,i){let o=b.createElement("template");return o.innerHTML=s,o}}function w(s,i,o=s,a){if(i===C)return i;let l=a!==void 0?o._$Co?.[a]:o._$Cl,p=O(i)?void 0:i._$litDirective$;return l?.constructor!==p&&(l?._$AO?.(!1),p===void 0?l=void 0:(l=new p(s),l._$AT(s,o,a)),a!==void 0?(o._$Co??=[])[a]=l:o._$Cl=l),l!==void 0&&(i=w(s,l._$AS(s,i.values),l,a)),i}class at{constructor(s,i){this._$AV=[],this._$AN=void 0,this._$AD=s,this._$AM=i}get parentNode(){return this._$AM.parentNode}get _$AU(){return this._$AM._$AU}u(s){let{el:{content:i},parts:o}=this._$AD,a=(s?.creationScope??b).importNode(i,!0);S.currentNode=a;let l=S.nextNode(),p=0,c=0,d=o[0];for(;d!==void 0;){if(p===d.index){let _;d.type===2?_=new N(l,l.nextSibling,this,s):d.type===1?_=new d.ctor(l,d.name,d.strings,this,s):d.type===6&&(_=new dt(l,this,s)),this._$AV.push(_),d=o[++c]}p!==d?.index&&(l=S.nextNode(),p++)}return S.currentNode=b,a}p(s){let i=0;for(let o of this._$AV)o!==void 0&&(o.strings!==void 0?(o._$AI(s,o,i),i+=o.strings.length-2):o._$AI(s[i])),i++}}class N{get _$AU(){return this._$AM?._$AU??this._$Cv}constructor(s,i,o,a){this.type=2,this._$AH=t,this._$AN=void 0,this._$AA=s,this._$AB=i,this._$AM=o,this.options=a,this._$Cv=a?.isConnected??!0}get parentNode(){let s=this._$AA.parentNode,i=this._$AM;return i!==void 0&&s?.nodeType===11&&(s=i.parentNode),s}get startNode(){return this._$AA}get endNode(){return this._$AB}_$AI(s,i=this){s=w(this,s,i),O(s)?s===t||s==null||s===""?(this._$AH!==t&&this._$AR(),this._$AH=t):s!==this._$AH&&s!==C&&this._(s):s._$litType$!==void 0?this.$(s):s.nodeType!==void 0?this.T(s):Et(s)?this.k(s):this._(s)}O(s){return this._$AA.parentNode.insertBefore(s,this._$AB)}T(s){this._$AH!==s&&(this._$AR(),this._$AH=this.O(s))}_(s){this._$AH!==t&&O(this._$AH)?this._$AA.nextSibling.data=s:this.T(b.createTextNode(s)),this._$AH=s}$(s){let{values:i,_$litType$:o}=s,a=typeof o=="number"?this._$AC(s):(o.el===void 0&&(o.el=M.createElement(ht(o.h,o.h[0]),this.options)),o);if(this._$AH?._$AD===a)this._$AH.p(i);else{let l=new at(a,this),p=l.u(this.options);l.p(i),this.T(p),this._$AH=l}}_$AC(s){let i=rt.get(s.strings);return i===void 0&&rt.set(s.strings,i=new M(s)),i}k(s){W(this._$AH)||(this._$AH=[],this._$AR());let i=this._$AH,o,a=0;for(let l of s)a===i.length?i.push(o=new N(this.O(U()),this.O(U()),this,this.options)):o=i[a],o._$AI(l),a++;a<i.length&&(this._$AR(o&&o._$AB.nextSibling,a),i.length=a)}_$AR(s=this._$AA.nextSibling,i){for(this._$AP?.(!1,!0,i);s!==this._$AB;){let o=X(s).nextSibling;X(s).remove(),s=o}}setConnected(s){this._$AM===void 0&&(this._$Cv=s,this._$AP?.(s))}}class T{get tagName(){return this.element.tagName}get _$AU(){return this._$AM._$AU}constructor(s,i,o,a,l){this.type=1,this._$AH=t,this._$AN=void 0,this.element=s,this.name=i,this._$AM=a,this.options=l,o.length>2||o[0]!==""||o[1]!==""?(this._$AH=Array(o.length-1).fill(new String),this.strings=o):this._$AH=t}_$AI(s,i=this,o,a){let l=this.strings,p=!1;if(l===void 0)s=w(this,s,i,0),p=!O(s)||s!==this._$AH&&s!==C,p&&(this._$AH=s);else{let c=s,d,_;for(s=l[0],d=0;d<l.length-1;d++)_=w(this,c[o+d],i,d),_===C&&(_=this._$AH[d]),p||=!O(_)||_!==this._$AH[d],_===t?s=t:s!==t&&(s+=(_??"")+l[d+1]),this._$AH[d]=_}p&&!a&&this.j(s)}j(s){s===t?this.element.removeAttribute(this.name):this.element.setAttribute(this.name,s??"")}}class lt extends T{constructor(){super(...arguments),this.type=3}j(s){this.element[this.name]=s===t?void 0:s}}class ct extends T{constructor(){super(...arguments),this.type=4}j(s){this.element.toggleAttribute(this.name,!!s&&s!==t)}}class pt extends T{constructor(s,i,o,a,l){super(s,i,o,a,l),this.type=5}_$AI(s,i=this){if((s=w(this,s,i,0)??t)===C)return;let o=this._$AH,a=s===t&&o!==t||s.capture!==o.capture||s.once!==o.once||s.passive!==o.passive,l=s!==t&&(o===t||a);a&&this.element.removeEventListener(this.name,this,o),l&&this.element.addEventListener(this.name,this,s),this._$AH=s}handleEvent(s){typeof this._$AH=="function"?this._$AH.call(this.options?.host??this.element,s):this._$AH.handleEvent(s)}}class dt{constructor(s,i,o){this.element=s,this.type=6,this._$AN=void 0,this._$AM=i,this.options=o}get _$AU(){return this._$AM._$AU}_$AI(s){w(this,s)}}var Ct=V.litHtmlPolyfillSupport;Ct?.(M,N),(V.litHtmlVersions??=[]).push("3.3.3");var ut=(s,i,o)=>{let a=o?.renderBefore??i,l=a._$litPart$;if(l===void 0){let p=o?.renderBefore??null;a._$litPart$=l=new N(i.insertBefore(U(),p),p,void 0,o??{})}return l._$AI(s),l};var K=globalThis;class n extends m{constructor(){super(...arguments),this.renderOptions={host:this},this._$Do=void 0}createRenderRoot(){let s=super.createRenderRoot();return this.renderOptions.renderBefore??=s.firstChild,s}update(s){let i=this.render();this.hasUpdated||(this.renderOptions.isConnected=this.isConnected),super.update(s),this._$Do=ut(i,this.renderRoot,this.renderOptions)}connectedCallback(){super.connectedCallback(),this._$Do?.setConnected(!0)}disconnectedCallback(){super.disconnectedCallback(),this._$Do?.setConnected(!1)}render(){return C}}n._$litElement$=!0,n.finalized=!0,K.litElementHydrateSupport?.({LitElement:n});var wt=K.litElementPolyfillSupport;wt?.({LitElement:n});(K.litElementVersions??=[]).push("4.2.2");export{h,r,e,E,t,n};
=======
var H = globalThis,
	L =
		H.ShadowRoot &&
		(H.ShadyCSS === void 0 || H.ShadyCSS.nativeShadow) &&
		"adoptedStyleSheets" in Document.prototype &&
		"replace" in CSSStyleSheet.prototype,
	B = Symbol(),
	F = new WeakMap();
class D {
	constructor(s, i, o) {
		if (((this._$cssResult$ = !0), o !== B))
			throw Error(
				"CSSResult is not constructable. Use `unsafeCSS` or `css` instead.",
			);
		(this.cssText = s), (this.t = i);
	}
	get styleSheet() {
		let s = this.o,
			i = this.t;
		if (L && s === void 0) {
			const o = i !== void 0 && i.length === 1;
			o && (s = F.get(i)),
				s === void 0 &&
					((this.o = s = new CSSStyleSheet()).replaceSync(this.cssText),
					o && F.set(i, s));
		}
		return s;
	}
	toString() {
		return this.cssText;
	}
}
var d = (s) => new D(typeof s === "string" ? s : `${s}`, void 0, B),
	r = (s, ...i) => {
		const o =
			s.length === 1
				? s[0]
				: i.reduce(
						(h, a, c) =>
							h +
							((l) => {
								if (l._$cssResult$ === !0) return l.cssText;
								if (typeof l === "number") return l;
								throw Error(
									`Value passed to 'css' function must be a 'css' function result: ${l}. Use 'unsafeCSS' to pass non-literal values, but take care to ensure page security.`,
								);
							})(a) +
							s[c + 1],
						s[0],
					);
		return new D(o, s, B);
	},
	J = (s, i) => {
		if (L)
			s.adoptedStyleSheets = i.map((o) =>
				o instanceof CSSStyleSheet ? o : o.styleSheet,
			);
		else
			for (const o of i) {
				const h = document.createElement("style"),
					a = H.litNonce;
				a !== void 0 && h.setAttribute("nonce", a),
					(h.textContent = o.cssText),
					s.appendChild(h);
			}
	},
	z = L
		? (s) => s
		: (s) =>
				s instanceof CSSStyleSheet
					? ((i) => {
							let o = "";
							for (const h of i.cssRules) o += h.cssText;
							return d(o);
						})(s)
					: s;
var {
		is: $t,
		defineProperty: _t,
		getOwnPropertyDescriptor: ft,
		getOwnPropertyNames: At,
		getOwnPropertySymbols: mt,
		getPrototypeOf: gt,
	} = Object,
	j = globalThis,
	Z = j.trustedTypes,
	yt = Z ? Z.emptyScript : "",
	vt = j.reactiveElementPolyfillSupport,
	w = (s, _i) => s,
	I = {
		toAttribute(s, i) {
			switch (i) {
				case Boolean:
					s = s ? yt : null;
					break;
				case Object:
				case Array:
					s = s == null ? s : JSON.stringify(s);
			}
			return s;
		},
		fromAttribute(s, i) {
			let o = s;
			switch (i) {
				case Boolean:
					o = s !== null;
					break;
				case Number:
					o = s === null ? null : Number(s);
					break;
				case Object:
				case Array:
					try {
						o = JSON.parse(s);
					} catch (_h) {
						o = null;
					}
			}
			return o;
		},
	},
	Q = (s, i) => !$t(s, i),
	G = {
		attribute: !0,
		type: String,
		converter: I,
		reflect: !1,
		useDefault: !1,
		hasChanged: Q,
	};
(Symbol.metadata ??= Symbol("metadata")),
	(j.litPropertyMetadata ??= new WeakMap());
class m extends HTMLElement {
	static addInitializer(s) {
		m._$Ei(), (m.l ??= []).push(s);
	}
	static get observedAttributes() {
		return m.finalize(), m._$Eh && [...m._$Eh.keys()];
	}
	static createProperty(s, i = G) {
		if (
			(i.state && (i.attribute = !1),
			m._$Ei(),
			Object.hasOwn(m.prototype, s) && ((i = Object.create(i)).wrapped = !0),
			m.elementProperties.set(s, i),
			!i.noAccessor)
		) {
			const o = Symbol(),
				h = m.getPropertyDescriptor(s, o, i);
			h !== void 0 && _t(m.prototype, s, h);
		}
	}
	static getPropertyDescriptor(s, i, o) {
		const { get: h, set: a } = ft(m.prototype, s) ?? {
			get() {
				return this[i];
			},
			set(c) {
				this[i] = c;
			},
		};
		return {
			get: h,
			set(c) {
				const l = h?.call(this);
				a?.call(this, c), this.requestUpdate(s, l, o);
			},
			configurable: !0,
			enumerable: !0,
		};
	}
	static getPropertyOptions(s) {
		return m.elementProperties.get(s) ?? G;
	}
	static _$Ei() {
		if (Object.hasOwn(m, w("elementProperties"))) return;
		const s = gt(m);
		s.finalize(),
			s.l !== void 0 && (m.l = [...s.l]),
			(m.elementProperties = new Map(s.elementProperties));
	}
	static finalize() {
		if (Object.hasOwn(m, w("finalized"))) return;
		if (((m.finalized = !0), m._$Ei(), Object.hasOwn(m, w("properties")))) {
			const i = m.properties,
				o = [...At(i), ...mt(i)];
			for (const h of o) m.createProperty(h, i[h]);
		}
		const s = m[Symbol.metadata];
		if (s !== null) {
			const i = litPropertyMetadata.get(s);
			if (i !== void 0) for (const [o, h] of i) m.elementProperties.set(o, h);
		}
		m._$Eh = new Map();
		for (const [i, o] of m.elementProperties) {
			const h = m._$Eu(i, o);
			h !== void 0 && m._$Eh.set(h, i);
		}
		m.elementStyles = m.finalizeStyles(m.styles);
	}
	static finalizeStyles(s) {
		const i = [];
		if (Array.isArray(s)) {
			const o = new Set(s.flat(1 / 0).reverse());
			for (const h of o) i.unshift(z(h));
		} else s !== void 0 && i.push(z(s));
		return i;
	}
	static _$Eu(s, i) {
		const o = i.attribute;
		return o === !1
			? void 0
			: typeof o === "string"
				? o
				: typeof s === "string"
					? s.toLowerCase()
					: void 0;
	}
	constructor() {
		super(),
			(this._$Ep = void 0),
			(this.isUpdatePending = !1),
			(this.hasUpdated = !1),
			(this._$Em = null),
			this._$Ev();
	}
	_$Ev() {
		(this._$ES = new Promise((s) => (this.enableUpdating = s))),
			(this._$AL = new Map()),
			this._$E_(),
			this.requestUpdate(),
			this.constructor.l?.forEach((s) => s(this));
	}
	addController(s) {
		(this._$EO ??= new Set()).add(s),
			this.renderRoot !== void 0 && this.isConnected && s.hostConnected?.();
	}
	removeController(s) {
		this._$EO?.delete(s);
	}
	_$E_() {
		const s = new Map(),
			i = this.constructor.elementProperties;
		for (const o of i.keys())
			Object.hasOwn(this, o) && (s.set(o, this[o]), delete this[o]);
		s.size > 0 && (this._$Ep = s);
	}
	createRenderRoot() {
		const s =
			this.shadowRoot ?? this.attachShadow(this.constructor.shadowRootOptions);
		return J(s, this.constructor.elementStyles), s;
	}
	connectedCallback() {
		(this.renderRoot ??= this.createRenderRoot()),
			this.enableUpdating(!0),
			this._$EO?.forEach((s) => s.hostConnected?.());
	}
	enableUpdating(_s) {}
	disconnectedCallback() {
		this._$EO?.forEach((s) => s.hostDisconnected?.());
	}
	attributeChangedCallback(s, _i, o) {
		this._$AK(s, o);
	}
	_$ET(s, i) {
		const o = this.constructor.elementProperties.get(s),
			h = this.constructor._$Eu(s, o);
		if (h !== void 0 && o.reflect === !0) {
			const a = (
				o.converter?.toAttribute !== void 0 ? o.converter : I
			).toAttribute(i, o.type);
			(this._$Em = s),
				a == null ? this.removeAttribute(h) : this.setAttribute(h, a),
				(this._$Em = null);
		}
	}
	_$AK(s, i) {
		const o = this.constructor,
			h = o._$Eh.get(s);
		if (h !== void 0 && this._$Em !== h) {
			const a = o.getPropertyOptions(h),
				c =
					typeof a.converter === "function"
						? { fromAttribute: a.converter }
						: a.converter?.fromAttribute !== void 0
							? a.converter
							: I;
			this._$Em = h;
			const l = c.fromAttribute(i, a.type);
			(this[h] = l ?? this._$Ej?.get(h) ?? l), (this._$Em = null);
		}
	}
	requestUpdate(s, i, o, h = !1, a) {
		if (s !== void 0) {
			const c = this.constructor;
			if (
				(h === !1 && (a = this[s]),
				(o ??= c.getPropertyOptions(s)),
				!(
					(o.hasChanged ?? Q)(a, i) ||
					(o.useDefault &&
						o.reflect &&
						a === this._$Ej?.get(s) &&
						!this.hasAttribute(c._$Eu(s, o)))
				))
			)
				return;
			this.C(s, i, o);
		}
		this.isUpdatePending === !1 && (this._$ES = this._$EP());
	}
	C(s, i, { useDefault: o, reflect: h, wrapped: a }, c) {
		(o &&
			!(this._$Ej ??= new Map()).has(s) &&
			(this._$Ej.set(s, c ?? i ?? this[s]), a !== !0 || c !== void 0)) ||
			(this._$AL.has(s) ||
				(this.hasUpdated || o || (i = void 0), this._$AL.set(s, i)),
			h === !0 && this._$Em !== s && (this._$Eq ??= new Set()).add(s));
	}
	async _$EP() {
		this.isUpdatePending = !0;
		try {
			await this._$ES;
		} catch (i) {
			Promise.reject(i);
		}
		const s = this.scheduleUpdate();
		return s != null && (await s), !this.isUpdatePending;
	}
	scheduleUpdate() {
		return this.performUpdate();
	}
	performUpdate() {
		if (!this.isUpdatePending) return;
		if (!this.hasUpdated) {
			if (((this.renderRoot ??= this.createRenderRoot()), this._$Ep)) {
				for (const [h, a] of this._$Ep) this[h] = a;
				this._$Ep = void 0;
			}
			const o = this.constructor.elementProperties;
			if (o.size > 0)
				for (const [h, a] of o) {
					const { wrapped: c } = a,
						l = this[h];
					c !== !0 ||
						this._$AL.has(h) ||
						l === void 0 ||
						this.C(h, void 0, a, l);
				}
		}
		let s = !1,
			i = this._$AL;
		try {
			(s = this.shouldUpdate(i)),
				s
					? (this.willUpdate(i),
						this._$EO?.forEach((o) => o.hostUpdate?.()),
						this.update(i))
					: this._$EM();
		} catch (o) {
			throw ((s = !1), this._$EM(), o);
		}
		s && this._$AE(i);
	}
	willUpdate(_s) {}
	_$AE(s) {
		this._$EO?.forEach((i) => i.hostUpdated?.()),
			this.hasUpdated || ((this.hasUpdated = !0), this.firstUpdated(s)),
			this.updated(s);
	}
	_$EM() {
		(this._$AL = new Map()), (this.isUpdatePending = !1);
	}
	get updateComplete() {
		return this.getUpdateComplete();
	}
	getUpdateComplete() {
		return this._$ES;
	}
	shouldUpdate(_s) {
		return !0;
	}
	update(_s) {
		(this._$Eq &&= this._$Eq.forEach((i) => this._$ET(i, this[i]))),
			this._$EM();
	}
	updated(_s) {}
	firstUpdated(_s) {}
}
(m.elementStyles = []),
	(m.shadowRootOptions = { mode: "open" }),
	(m[w("elementProperties")] = new Map()),
	(m[w("finalized")] = new Map()),
	vt?.({ ReactiveElement: m }),
	(j.reactiveElementVersions ??= []).push("2.1.2");
var V = globalThis,
	X = (s) => s,
	k = V.trustedTypes,
	Y = k ? k.createPolicy("lit-html", { createHTML: (s) => s }) : void 0;
var g = `lit$${Math.random().toFixed(9).slice(2)}$`,
	ot = `?${g}`,
	St = `<${ot}>`,
	E = document,
	U = () => E.createComment(""),
	O = (s) => s === null || (typeof s !== "object" && typeof s !== "function"),
	W = Array.isArray,
	Et = (s) => W(s) || typeof s?.[Symbol.iterator] === "function";
var P = /<(?:(!--|\/[^a-zA-Z])|(\/?[a-zA-Z][^>\s]*)|(\/?$))/g,
	tt = /-->/g,
	et = />/g,
	v =
		/>|[ 	\n\f\r](?:([^\s"'>=/]+)([ 	\n\f\r]*=[ 	\n\f\r]*(?:[^ 	\n\f\r"'`<>=]|("|')|))|$)/g,
	st = /'/g,
	it = /"/g,
	nt = /^(?:script|style|textarea|title)$/i,
	q =
		(s) =>
		(i, ...o) => ({ _$litType$: s, strings: i, values: o }),
	e = q(1),
	x = q(2),
	_Mt = q(3),
	b = Symbol.for("lit-noChange"),
	t = Symbol.for("lit-nothing"),
	rt = new WeakMap(),
	S = E.createTreeWalker(E, 129);
function ht(s, i) {
	if (!W(s) || !Object.hasOwn(s, "raw"))
		throw Error("invalid template strings array");
	return Y !== void 0 ? Y.createHTML(i) : i;
}
var bt = (s, i) => {
	let o = s.length - 1,
		h = [],
		a,
		c = i === 2 ? "<svg>" : i === 3 ? "<math>" : "",
		l = P;
	for (let p = 0; p < o; p++) {
		let _ = s[p],
			R,
			u,
			f = -1,
			A = 0;
		for (; A < _.length && ((l.lastIndex = A), (u = l.exec(_)), u !== null); )
			(A = l.lastIndex),
				l === P
					? u[1] === "!--"
						? (l = tt)
						: u[1] !== void 0
							? (l = et)
							: u[2] !== void 0
								? (nt.test(u[2]) && (a = RegExp(`</${u[2]}`, "g")), (l = v))
								: u[3] !== void 0 && (l = v)
					: l === v
						? u[0] === ">"
							? ((l = a ?? P), (f = -1))
							: u[1] === void 0
								? (f = -2)
								: ((f = l.lastIndex - u[2].length),
									(R = u[1]),
									(l = u[3] === void 0 ? v : u[3] === '"' ? it : st))
						: l === it || l === st
							? (l = v)
							: l === tt || l === et
								? (l = P)
								: ((l = v), (a = void 0));
		const y = l === v && s[p + 1].startsWith("/>") ? " " : "";
		c +=
			l === P
				? _ + St
				: f >= 0
					? (h.push(R), `${_.slice(0, f)}$lit$${_.slice(f)}${g}${y}`)
					: _ + g + (f === -2 ? p : y);
	}
	return [
		ht(
			s,
			c + (s[o] || "<?>") + (i === 2 ? "</svg>" : i === 3 ? "</math>" : ""),
		),
		h,
	];
};
class M {
	constructor({ strings: s, _$litType$: i }, o) {
		let h;
		this.parts = [];
		let a = 0,
			c = 0,
			l = s.length - 1,
			p = this.parts,
			[_, R] = bt(s, i);
		if (
			((this.el = M.createElement(_, o)),
			(S.currentNode = this.el.content),
			i === 2 || i === 3)
		) {
			const u = this.el.content.firstChild;
			u.replaceWith(...u.childNodes);
		}
		for (; (h = S.nextNode()) !== null && p.length < l; ) {
			if (h.nodeType === 1) {
				if (h.hasAttributes())
					for (const u of h.getAttributeNames())
						if (u.endsWith("$lit$")) {
							const f = R[c++],
								A = h.getAttribute(u).split(g),
								y = /([.?@])?(.*)/.exec(f);
							p.push({
								type: 1,
								index: a,
								name: y[2],
								strings: A,
								ctor:
									y[1] === "." ? lt : y[1] === "?" ? ct : y[1] === "@" ? pt : T,
							}),
								h.removeAttribute(u);
						} else
							u.startsWith(g) &&
								(p.push({ type: 6, index: a }), h.removeAttribute(u));
				if (nt.test(h.tagName)) {
					const u = h.textContent.split(g),
						f = u.length - 1;
					if (f > 0) {
						h.textContent = k ? k.emptyScript : "";
						for (let A = 0; A < f; A++)
							h.append(u[A], U()),
								S.nextNode(),
								p.push({ type: 2, index: ++a });
						h.append(u[f], U());
					}
				}
			} else if (h.nodeType === 8)
				if (h.data === ot) p.push({ type: 2, index: a });
				else {
					let u = -1;
					for (; (u = h.data.indexOf(g, u + 1)) !== -1; )
						p.push({ type: 7, index: a }), (u += g.length - 1);
				}
			a++;
		}
	}
	static createElement(s, _i) {
		const o = E.createElement("template");
		return (o.innerHTML = s), o;
	}
}
function C(s, i, o = s, h) {
	if (i === b) return i;
	let a = h !== void 0 ? o._$Co?.[h] : o._$Cl,
		c = O(i) ? void 0 : i._$litDirective$;
	return (
		a?.constructor !== c &&
			(a?._$AO?.(!1),
			c === void 0 ? (a = void 0) : ((a = new c(s)), a._$AT(s, o, h)),
			h !== void 0 ? ((o._$Co ??= [])[h] = a) : (o._$Cl = a)),
		a !== void 0 && (i = C(s, a._$AS(s, i.values), a, h)),
		i
	);
}
class at {
	constructor(s, i) {
		(this._$AV = []), (this._$AN = void 0), (this._$AD = s), (this._$AM = i);
	}
	get parentNode() {
		return this._$AM.parentNode;
	}
	get _$AU() {
		return this._$AM._$AU;
	}
	u(s) {
		const {
				el: { content: i },
				parts: o,
			} = this._$AD,
			h = (s?.creationScope ?? E).importNode(i, !0);
		S.currentNode = h;
		let a = S.nextNode(),
			c = 0,
			l = 0,
			p = o[0];
		for (; p !== void 0; ) {
			if (c === p.index) {
				let _;
				p.type === 2
					? (_ = new N(a, a.nextSibling, this, s))
					: p.type === 1
						? (_ = new p.ctor(a, p.name, p.strings, this, s))
						: p.type === 6 && (_ = new dt(a, this, s)),
					this._$AV.push(_),
					(p = o[++l]);
			}
			c !== p?.index && ((a = S.nextNode()), c++);
		}
		return (S.currentNode = E), h;
	}
	p(s) {
		let i = 0;
		for (const o of this._$AV)
			o !== void 0 &&
				(o.strings !== void 0
					? (o._$AI(s, o, i), (i += o.strings.length - 2))
					: o._$AI(s[i])),
				i++;
	}
}
class N {
	get _$AU() {
		return this._$AM?._$AU ?? this._$Cv;
	}
	constructor(s, i, o, h) {
		(this.type = 2),
			(this._$AH = t),
			(this._$AN = void 0),
			(this._$AA = s),
			(this._$AB = i),
			(this._$AM = o),
			(this.options = h),
			(this._$Cv = h?.isConnected ?? !0);
	}
	get parentNode() {
		let s = this._$AA.parentNode,
			i = this._$AM;
		return i !== void 0 && s?.nodeType === 11 && (s = i.parentNode), s;
	}
	get startNode() {
		return this._$AA;
	}
	get endNode() {
		return this._$AB;
	}
	_$AI(s, i = this) {
		(s = C(this, s, i)),
			O(s)
				? s === t || s == null || s === ""
					? (this._$AH !== t && this._$AR(), (this._$AH = t))
					: s !== this._$AH && s !== b && this._(s)
				: s._$litType$ !== void 0
					? this.$(s)
					: s.nodeType !== void 0
						? this.T(s)
						: Et(s)
							? this.k(s)
							: this._(s);
	}
	O(s) {
		return this._$AA.parentNode.insertBefore(s, this._$AB);
	}
	T(s) {
		this._$AH !== s && (this._$AR(), (this._$AH = this.O(s)));
	}
	_(s) {
		this._$AH !== t && O(this._$AH)
			? (this._$AA.nextSibling.data = s)
			: this.T(E.createTextNode(s)),
			(this._$AH = s);
	}
	$(s) {
		const { values: i, _$litType$: o } = s,
			h =
				typeof o === "number"
					? this._$AC(s)
					: (o.el === void 0 &&
							(o.el = M.createElement(ht(o.h, o.h[0]), this.options)),
						o);
		if (this._$AH?._$AD === h) this._$AH.p(i);
		else {
			const a = new at(h, this),
				c = a.u(this.options);
			a.p(i), this.T(c), (this._$AH = a);
		}
	}
	_$AC(s) {
		let i = rt.get(s.strings);
		return i === void 0 && rt.set(s.strings, (i = new M(s))), i;
	}
	k(s) {
		W(this._$AH) || ((this._$AH = []), this._$AR());
		let i = this._$AH,
			o,
			h = 0;
		for (const a of s)
			h === i.length
				? i.push((o = new N(this.O(U()), this.O(U()), this, this.options)))
				: (o = i[h]),
				o._$AI(a),
				h++;
		h < i.length && (this._$AR(o?._$AB.nextSibling, h), (i.length = h));
	}
	_$AR(s = this._$AA.nextSibling, i) {
		for (this._$AP?.(!1, !0, i); s !== this._$AB; ) {
			const o = X(s).nextSibling;
			X(s).remove(), (s = o);
		}
	}
	setConnected(s) {
		this._$AM === void 0 && ((this._$Cv = s), this._$AP?.(s));
	}
}
class T {
	get tagName() {
		return this.element.tagName;
	}
	get _$AU() {
		return this._$AM._$AU;
	}
	constructor(s, i, o, h, a) {
		(this.type = 1),
			(this._$AH = t),
			(this._$AN = void 0),
			(this.element = s),
			(this.name = i),
			(this._$AM = h),
			(this.options = a),
			o.length > 2 || o[0] !== "" || o[1] !== ""
				? ((this._$AH = Array(o.length - 1).fill(new String())),
					(this.strings = o))
				: (this._$AH = t);
	}
	_$AI(s, i = this, o, h) {
		let a = this.strings,
			c = !1;
		if (a === void 0)
			(s = C(this, s, i, 0)),
				(c = !O(s) || (s !== this._$AH && s !== b)),
				c && (this._$AH = s);
		else {
			let l = s,
				p,
				_;
			for (s = a[0], p = 0; p < a.length - 1; p++)
				(_ = C(this, l[o + p], i, p)),
					_ === b && (_ = this._$AH[p]),
					(c ||= !O(_) || _ !== this._$AH[p]),
					_ === t ? (s = t) : s !== t && (s += (_ ?? "") + a[p + 1]),
					(this._$AH[p] = _);
		}
		c && !h && this.j(s);
	}
	j(s) {
		s === t
			? this.element.removeAttribute(this.name)
			: this.element.setAttribute(this.name, s ?? "");
	}
}
class lt extends T {
	constructor() {
		super(...arguments), (this.type = 3);
	}
	j(s) {
		this.element[this.name] = s === t ? void 0 : s;
	}
}
class ct extends T {
	constructor() {
		super(...arguments), (this.type = 4);
	}
	j(s) {
		this.element.toggleAttribute(this.name, !!s && s !== t);
	}
}
class pt extends T {
	constructor(s, i, o, h, a) {
		super(s, i, o, h, a), (this.type = 5);
	}
	_$AI(s, i = this) {
		if ((s = C(this, s, i, 0) ?? t) === b) return;
		const o = this._$AH,
			h =
				(s === t && o !== t) ||
				s.capture !== o.capture ||
				s.once !== o.once ||
				s.passive !== o.passive,
			a = s !== t && (o === t || h);
		h && this.element.removeEventListener(this.name, this, o),
			a && this.element.addEventListener(this.name, this, s),
			(this._$AH = s);
	}
	handleEvent(s) {
		typeof this._$AH === "function"
			? this._$AH.call(this.options?.host ?? this.element, s)
			: this._$AH.handleEvent(s);
	}
}
class dt {
	constructor(s, i, o) {
		(this.element = s),
			(this.type = 6),
			(this._$AN = void 0),
			(this._$AM = i),
			(this.options = o);
	}
	get _$AU() {
		return this._$AM._$AU;
	}
	_$AI(s) {
		C(this, s);
	}
}
var Ct = V.litHtmlPolyfillSupport;
Ct?.(M, N), (V.litHtmlVersions ??= []).push("3.3.3");
var ut = (s, i, o) => {
	let h = o?.renderBefore ?? i,
		a = h._$litPart$;
	if (a === void 0) {
		const c = o?.renderBefore ?? null;
		h._$litPart$ = a = new N(i.insertBefore(U(), c), c, void 0, o ?? {});
	}
	return a._$AI(s), a;
};
var K = globalThis;
class n extends m {
	constructor() {
		super(...arguments),
			(this.renderOptions = { host: this }),
			(this._$Do = void 0);
	}
	createRenderRoot() {
		const s = super.createRenderRoot();
		return (this.renderOptions.renderBefore ??= s.firstChild), s;
	}
	update(s) {
		const i = this.render();
		this.hasUpdated || (this.renderOptions.isConnected = this.isConnected),
			super.update(s),
			(this._$Do = ut(i, this.renderRoot, this.renderOptions));
	}
	connectedCallback() {
		super.connectedCallback(), this._$Do?.setConnected(!0);
	}
	disconnectedCallback() {
		super.disconnectedCallback(), this._$Do?.setConnected(!1);
	}
	render() {
		return b;
	}
}
(n._$litElement$ = !0),
	(n.finalized = !0),
	K.litElementHydrateSupport?.({ LitElement: n });
var wt = K.litElementPolyfillSupport;
wt?.({ LitElement: n });
(K.litElementVersions ??= []).push("4.2.2");
export { d, e, n, r, t, x };
>>>>>>> ea45c310175bae88c6e09cdd6cbb9773ee0ea3bc:packages/suspenders/hooks/board-html/vendor/lit-9ab93f5debb235da.js
