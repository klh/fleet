import{s,t,r}from"./lit-c70hdayb.js";class a extends Event{constructor(e){super(e,{bubbles:!0,composed:!0})}}class i extends a{static eventName="feed-refresh-requested";feed;constructor(e){super(i.eventName);this.feed=e}}class d extends a{static eventName="error-dismiss-requested";source;constructor(e){super(d.eventName);this.source=e}}var o=s`
	.retry {
		background: none;
		border: 1px solid var(--klh-danger);
		color: var(--klh-danger-ink);
		border-radius: 2px;
		font: inherit;
		font-size: 10px;
		padding: 1px 8px;
		cursor: pointer;
		margin-left: 8px;
	}
`;class n extends r{static properties={text:{type:String},feed:{type:String,reflect:!0}};static styles=[s`
			:host([hidden]) {
				display: none;
			}
		`,o];constructor(){super();this.text="",this.feed=""}willUpdate(){this.hidden=!this.text}retry(){this.dispatchEvent(this.feed?new i(this.feed):new d(this.id))}render(){return t`<span role="alert">${this.text}</span
			><button class="retry" type="button" @click=${this.retry}>
				retry
			</button>`}}if(!customElements.get("klh-err-banner"))customElements.define("klh-err-banner",n);
export{i,o,n};
