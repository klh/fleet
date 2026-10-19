import{r,e,s}from"./lit-c5g9ct2w.js";import{a}from"./lit-6msn3zmv.js";var c=r`
	.hint {
		font-size: 10.5px;
		color: var(--klh-dim);
		margin: 2px 0 8px;
	}
	ol {
		list-style: none;
		counter-reset: ex;
		margin: 8px 0;
		padding: 0;
		max-width: 640px;
	}
	li {
		display: flex;
		gap: 6px;
		align-items: center;
		padding: 4px 0;
		border-bottom: 1px solid var(--klh-rule);
	}
	li::before {
		counter-increment: ex;
		content: counter(ex) ". ";
		font-size: 11px;
		color: var(--klh-dim);
		min-width: 22px;
	}
	.exv {
		flex: 1;
		font: 12px var(--klh-font-mono);
		word-break: break-all;
	}
	.add {
		display: flex;
		gap: 8px;
		align-items: flex-end;
		margin-top: 8px;
		max-width: 640px;
	}
	.add div {
		flex: 1;
	}
	label {
		display: block;
		font-size: 10px;
		color: var(--klh-dim);
		text-transform: uppercase;
		letter-spacing: 0.06em;
		margin: 8px 0 3px;
	}
	select {
		width: 100%;
		background: var(--klh-bg);
		color: var(--klh-ink);
		border: 1px solid var(--klh-edge);
		border-radius: 2px;
		padding: 5px 8px;
		font: 12px var(--klh-font-mono);
	}
	button {
		background: var(--klh-bg);
		color: var(--klh-ink);
		border: 1px solid var(--klh-edge-strong);
		border-radius: 2px;
		padding: 5px 12px;
		font: inherit;
		font-size: 11px;
		cursor: pointer;
	}
`;class o extends s{static properties={heading:{type:String},options:{type:Array},chain:{state:!0},pick:{state:!0}};static styles=[a,c];constructor(){super();this.heading="executor preference order",this.options=[],this.chain=[],this.pick=""}get carrier(){return this.querySelector('input[name="default_executors"]')}connectedCallback(){super.connectedCallback();let t=this.carrier?.value??"";this.chain=t.split(",").map((i)=>i.trim()).filter(Boolean)}set(t){this.chain=t;let i=this.carrier;if(i)i.value=t.join(",")}move(t,i){let l=t+i;if(l<0||l>=this.chain.length)return;let n=[...this.chain];[n[t],n[l]]=[n[l],n[t]],this.set(n)}add(){let i=this.renderRoot.querySelector("select")?.value??this.pick;if(i&&!this.chain.includes(i))this.set([...this.chain,i])}render(){return e`<h2>${this.heading}</h2>
			<p class="hint">
				dispatch walks this order as its fallback chain — first entry first; a
				dead lane re-dispatch advances to the next; the same-model tail rides
				claude's --fallback-model; claude is appended as the last resort unless
				enabled_executors blocks it. Empty list = claude only.
			</p>
			<ol aria-label="executor preference order">
				${this.chain.map((t,i)=>this.row(t,i))}
			</ol>
			<div class="add">
				<div>
					<label for="exadd">add executor (catalog)</label>
					<select id="exadd">
						${this.options.map((t)=>e`<option
									value=${t.value}
									?disabled=${this.chain.includes(t.value)}
								>
									${t.label}
								</option>`)}
					</select>
				</div>
				<button type="button" @click=${()=>this.add()}>add</button>
			</div>`}row(t,i){return e`<li data-v=${t}>
			<span class="exv">${t}</span>
			<button
				type="button"
				aria-label="move up ${t}"
				@click=${()=>this.move(i,-1)}
			>
				↑
			</button>
			<button
				type="button"
				aria-label="move down ${t}"
				@click=${()=>this.move(i,1)}
			>
				↓
			</button>
			<button
				type="button"
				aria-label="remove ${t}"
				@click=${()=>this.set(this.chain.filter((l,n)=>n!==i))}
			>
				✕
			</button>
		</li>`}}if(!customElements.get("klh-executor-editor"))customElements.define("klh-executor-editor",o);class d extends s{static properties={heading:{type:String},lines:{type:Array}};static styles=[a,r`
			pre {
				background: var(--klh-bg);
				border: 1px solid var(--klh-edge);
				border-radius: 2px;
				padding: 10px 12px;
				font: 11px/1.5 var(--klh-font-mono);
				overflow: auto;
				margin: 0;
			}
			.add {
				color: var(--klh-ok-hi);
				display: block;
			}
			.del {
				color: var(--klh-danger-ink);
				display: block;
			}
			.ctx {
				display: block;
			}
		`];constructor(){super();this.heading="",this.lines=[]}cls(t){return t.startsWith("+ ")?"add":t.startsWith("- ")?"del":"ctx"}render(){let t=this.lines.length?this.lines.map((i)=>e`<span class=${this.cls(i)}>${i}</span>`):e`no textual change`;return e`<h2>${this.heading}</h2>
			<pre class="diff">${t}</pre>`}}if(!customElements.get("klh-diff-view"))customElements.define("klh-diff-view",d);
