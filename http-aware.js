// HTTP-Aware Forms v3.2.0 — HTML forms that speak the whole of HTTP.
// https://github.com/steveAllen0112/http-aware-forms | MIT License | RFC 9110

const COMBINABLE_HEADERS = new Set([
	'accept', 'accept-charset', 'accept-encoding', 'accept-language',
	'cache-control', 'connection', 'content-encoding', 'expect',
	'if-match', 'if-none-match', 'prefer', 'te', 'trailer',
	'transfer-encoding', 'upgrade', 'via', 'warning', 'link'
]);

// The submittable elements (HTML §4.10.2, "Categories"): the controls that can
// put a pair on the wire. A form-associated custom element is one too.
const SUBMITTABLE = new Set(['BUTTON', 'INPUT', 'SELECT', 'TEXTAREA']);

// A `{name}` or `{name,format}` placeholder in a fieldset's value template.
const PLACEHOLDER = /\{([a-zA-Z_][a-zA-Z0-9_-]*)(?:,([^}]+))?\}/g;

/**
 * What the two composing fieldsets share: the controls a fieldset draws on
 * (those it contains, and those linked to it by `for=`), their current values,
 * and the interpolation of its `value` template. `{{` and `}}` are literal braces.
 */
class TemplatedFieldset extends HTMLFieldSetElement {
	get template() { return this.getAttribute('value') || ''; }

	/** The placeholder names the template refers to, escapes excluded. */
	get placeholders() {
		return [...this.template.replace(/\{\{|\}\}/g, '').matchAll(PLACEHOLDER)].map(m => m[1]);
	}

	get inputs() {
		return [...this.form.elements].filter(el =>
			el.getAttribute('for') === this.id || this.contains(el)
		);
	}

	get values() {
		const names = new Set(this.inputs.map(el => el.name));
		return Object.fromEntries(
			[...new FormData(this.form, this.form._submitter)].filter(([k]) => names.has(k))
		);
	}

	interpolate(template, values) {
		let result = template.replace(/\{\{/g, '\x00O\x00').replace(/\}\}/g, '\x00C\x00');
		result = result.replace(PLACEHOLDER, (match, name, fmt) => {
			return name in values ? this.form.formatValue(values[name], fmt) : match;
		});
		return result.replace(/\x00O\x00/g, '{').replace(/\x00C\x00/g, '}');
	}
}

class RequestHeader extends TemplatedFieldset {
	static get observedAttributes() { return ['header', 'value']; }

	get header() { return this.getAttribute('header') || ''; }

	computeValue() {
		const result = this.interpolate(this.template, this.values);
		return result && !/^[a-zA-Z_-]+=\s*$/.test(result) ? result : '';
	}
}
customElements.define('request-header', RequestHeader, { extends: 'fieldset' });

/**
 * <fieldset is="query-param" name="k" value="{op}.{q}"> — ONE form-data pair
 * composed from the controls it contains, for the value HTML has no way to
 * build out of several controls: an operator and its operand, a bound and its
 * comparison. The controls inside submit nothing of their own. The fieldset
 * submits `k=<value>` once every placeholder has a value, and nothing at all
 * otherwise — an empty box withdraws the condition instead of sending
 * `k=contains.` — and a disabled fieldset submits nothing, as a disabled
 * control does. Several fieldsets may share a name: each is its own pair.
 *
 * It goes wherever the form's data goes — the query for GET, HEAD and DELETE,
 * the body otherwise. Its name is namespaced like a control's, it owns that key
 * in the action-query merge, and its pair follows the form's other pairs.
 */
class QueryParam extends TemplatedFieldset {
	static get observedAttributes() { return ['name', 'value']; }

	get key() { return this.getAttribute('name') || ''; }

	/** The pair to submit under `wireKey`, or null when a placeholder is empty. */
	computePair(wireKey) {
		if (!wireKey) return null;
		const values = this.values;
		if (this.placeholders.some(name => !(name in values) || values[name] === '')) return null;
		return [wireKey, this.interpolate(this.template, values)];
	}
}
customElements.define('query-param', QueryParam, { extends: 'fieldset' });

/**
 * <fieldset is="name-space" name="x"> — the fields it contains are submitted as
 * `x[field]`. A marker with no behaviour: collectFormData reads the attribute.
 * Registered all the same, so the marker is an element upgrade rather than a
 * convention. The hyphen is required — see the note at the head of this file.
 */
class NameSpace extends HTMLFieldSetElement {}
customElements.define('name-space', NameSpace, { extends: 'fieldset' });

/* ============================================================
   NAMESPACED FIELDSETS — <fieldset is="name-space" name="lease">

   HTML models fieldset grouping in the DOM — a fieldset sits in
   form.elements, and HTMLFieldSetElement.elements scopes lookups to the
   controls it holds — and then throws that grouping away at submission
   time: two controls both named `cost`, in different fieldsets, both emit
   `cost=…` and the server cannot tell them apart. This supplies the missing
   half, opt-in and ON THE WIRE ONLY. The grammar is `subject[aspect]`, so
   `name="rate"` inside <fieldset is="name-space" name="lease"> is submitted
   as `lease[rate]`; nesting composes outward-in, `outer[inner][field]`.

   The marker is a REAL customized built-in, registered below. It carries no
   behaviour — collectFormData reads the attribute — but registering it means
   `is="name-space"` is an element upgrade rather than a private convention
   this library happens to honour, which is the whole reason `is=` was chosen
   over a data attribute.

   The hyphen is not decoration. A custom element name is REQUIRED to contain
   one, for customized built-ins exactly as for autonomous elements, so
   customElements.define('namespace', …) throws SyntaxError — and at the top
   level of this file that aborts the script and takes every form on the page
   with it. Measured in Chrome 144 rather than assumed: 'namespace' and 'nsx'
   both throw, 'name-space' defines.

   An UNMARKED fieldset is left alone, named or not. That is load-bearing,
   not incidental. `name` on a fieldset is inert natively and applications
   already use it for sectioning — one production form this was built against
   carries four such fieldsets — so a rule that namespaced every named
   fieldset would silently rename every field in forms that predate this
   feature. Only the marker opts in.
   ============================================================ */

class HTTPAwareForm extends HTMLFormElement {
	static formatters = {};

	/**
	 * EXTENSION POINTS. This library knows nothing about any other library or
	 * application, and these are how it stays that way. Add to them from a
	 * separate script — `http-aware-htmx.js` beside this file is the worked
	 * example — exactly as `http-aware-formatters.js` adds to `formatters`.
	 */

	/** `(headers, form) => void` — mutate the header list before the request goes. */
	static requestHooks = [];

	/** Attributes marking an element in a response as an out-of-band update. */
	static oobAttributes = ['data-swap-oob'];

	/** Response headers by which the server may redirect the swap. */
	static retargetHeaders = ['X-Retarget'];
	static reswapHeaders = ['X-Reswap'];

	/** First present value among `names`, or null. */
	static header(response, names) {
		for (const n of names) {
			const v = response.headers.get(n);
			if (v) return v;
		}
		return null;
	}

	/** CSS selector matching any element marked out-of-band. */
	static get oobSelector() {
		return HTTPAwareForm.oobAttributes.map(a => `[${a}]`).join(',');
	}

	formatValue(value, formatSpec) {
		value = value ?? '';
		const m = formatSpec?.match(/^(\w+)(?:\(([^)]*)\))?$/);
		return HTTPAwareForm.formatters[m?.[1]]?.(value, ...m?.[2]?.split(',').map(a => a.trim()) ?? []) ?? String(value);
	}

	preparedRequest = null;

	connectedCallback() {
		this.addEventListener('submit', this._handleNativeSubmit.bind(this));
		this._installAutoSubmit();
	}

	/**
	 * Auto-submit wiring. Two form attributes cooperate:
	 *
	 *   autosubmit="<events>"  Space-separated event names that arm an
	 *                          auto-submit (e.g. "change", "input change").
	 *   debounce="<duration>"  Delay between the arming event and the submit.
	 *
	 * `debounce` without `autosubmit` keeps the historical default of
	 * `input change` — free-text typing and select/checkbox commits both
	 * feed a per-control timer (keyed by element identity, so touching one
	 * input does not reset another's pending submit; a fast rep typing
	 * across cells gets one PATCH per cell, not one rolled-up PATCH).
	 *
	 * `autosubmit` without `debounce` submits immediately on the named
	 * events. `autosubmit="change"` gives commit-point saves — the browser
	 * fires `change` on blur-after-edit, on Enter in a text field, and on
	 * select/checkbox/radio/slider commit — with NO submit mid-typing, so
	 * an out-of-band re-render never races an input
	 * the user is still inside.
	 *
	 * Duration syntax: bare integer = milliseconds (canonical: `debounce="300"`).
	 * Suffixed forms `"300ms"` / `"0.5s"` / `"2s"` also accepted for readability
	 * in occasional long-running cases, but the platform default is ms — matches
	 * setTimeout / setInterval / requestAnimationFrame conventions.
	 */
	_installAutoSubmit() {
		const events = (this.getAttribute('autosubmit') || '').split(/\s+/).filter(Boolean);
		const raw = this.getAttribute('debounce');
		const ms = raw ? HTTPAwareForm._parseDuration(raw) : 0;
		if (!events.length) {
			if (!(ms > 0)) return;
			events.push('input', 'change');
		}

		// One timer per element (WeakMap so detached nodes get collected).
		this._debounceTimers = new WeakMap();

		const onEdit = (ev) => {
			const el = ev.target;
			if (!el || !el.name) return;
			if (el.type === 'hidden' || el.type === 'submit' || el.type === 'button') return;
			// Skip elements not actually inside this form (event might bubble
			// from a nested form, though that's malformed HTML).
			if (el.form !== this) return;

			const existing = this._debounceTimers.get(el);
			if (existing) clearTimeout(existing);
			if (!(ms > 0)) {
				this.requestSubmit();
				return;
			}
			const t = setTimeout(() => {
				this._debounceTimers.delete(el);
				this.requestSubmit();
			}, ms);
			this._debounceTimers.set(el, t);
		};

		for (const name of events) this.addEventListener(name, onEdit);
	}

	static _parseDuration(s) {
		const m = String(s).trim().match(/^(\d+(?:\.\d+)?)\s*(ms|s)?$/i);
		if (!m) return 0;
		const n = parseFloat(m[1]);
		const unit = (m[2] || 'ms').toLowerCase();
		return unit === 's' ? Math.round(n * 1000) : Math.round(n);
	}

	_handleNativeSubmit(event) {
		// Always preventDefault. The browser's default action on a submit
		// event is to natively submit the form (falls back to GET for any
		// method beyond GET/POST). Even synthetic submit events we dispatch
		// from our own requestSubmit() get that default-action treatment in
		// at least some Chromium contexts — leaving a stale GET fire alongside
		// our intentional fetch. preventDefault is harmless for the http-aware
		// path (we do the work ourselves anyway) and load-bearing against
		// native form submission for the non-http-aware path.
		event.preventDefault();
		event.stopPropagation();
		// Only kick off OUR submission flow when it's a native submit — when
		// our own requestSubmit dispatched the event, the fetch is already in
		// flight and recursing would loop.
		if (!event._httpAware) { this.requestSubmit(event.submitter); }
	}

	getHeaderBoundFields() {
		return new Set([...this.querySelectorAll('fieldset[is="request-header"]')].flatMap(el => el.inputs.flatMap(i=>i.name?[i.name]:[])));
	}

	/** The query-param fieldsets of this form, `form=` reassociation included. */
	_queryParams() {
		return [...this.elements].filter(el => el.tagName === 'FIELDSET' && el.getAttribute('is') === 'query-param');
	}

	/** The names of the controls a query-param fieldset composes — they submit nothing themselves. */
	getComposedFields() {
		return new Set(this._queryParams().flatMap(qp => qp.inputs.flatMap(i => i.name ? [i.name] : [])));
	}

	/**
	 * `name` as the namespace grammar spells it for a control placed where
	 * `node` is — the same grammar _applyNamespaces writes onto the DOM, read
	 * without renaming anything, for a fieldset that names a pair of its own.
	 */
	_wireName(node, name) {
		const groups = [];
		for (let n = node.parentElement; n && n !== this; n = n.parentElement) {
			if (n.tagName === 'FIELDSET' && n.getAttribute('is') === 'name-space' && n.getAttribute('name')) {
				groups.unshift(n.getAttribute('name'));
			}
		}
		return groups.length ? groups[0] + [...groups.slice(1), name].map(part => `[${part}]`).join('') : name;
	}

	collectHeaders() {
		const headerMap = new Map();

		this.querySelectorAll('fieldset[is="request-header"]').forEach(el => {
			const header = el.header?.toLowerCase(); if (!header) return;

			headerMap.set(header, (COMBINABLE_HEADERS.has(header) ? headerMap.get(header) || [] : []).concat(el.computeValue()));
		});

		// filter(x||===0) avoids trailing ", " from empty values; empty headers and 0 as value still allowed
		return [...headerMap].map(([n, v]) => [n, v.filter(x=>x||x===0).join(', ')]);
	}

	/**
	 * Apply the namespace grammar to the live DOM and hand back the
	 * [element, original name] pairs, so the caller can put every name back
	 * — always from a `finally`, since a half-renamed DOM is a corrupted one.
	 *
	 * Exemptions, each of them deliberate:
	 *  · the SUBMITTER. Its name is the action intent — form-level, not a
	 *    field of the group — which is also why the PATCH dirty filter below
	 *    exempts it. Namespacing it would turn a <button name="role"
	 *    value="sales_rep"> inside the sales_rep group into
	 *    sales_rep[role]=sales_rep.
	 *  · anything inside a fieldset[is="request-header"]: those fields are
	 *    bound out of the body and into a header already.
	 *  · anything inside a fieldset[is="query-param"]: those fields are the
	 *    template's variables, and the fieldset names the pair itself.
	 *  · a control reassociated to some other form by the `form=` attribute.
	 *  · fieldsets themselves. They appear in form.elements, and a namespace
	 *    fieldset has a name, but a fieldset submits nothing — and renaming
	 *    one would rewrite the very prefix its children are about to read.
	 */
	_applyNamespaces() {
		const renamed = [];
		for (const el of this.elements) {
			if (!el.name || el.tagName === 'FIELDSET') continue;
			if (el.form !== this) continue;
			if (el === this._submitter) continue;
			const groups = [];
			let headerBound = false;
			// The form is the ceiling for a control inside it; for one
			// reassociated in from elsewhere the walk simply runs out at the
			// document root, which matches fieldset.elements — the platform
			// scopes a fieldset by DOM containment, not by form association.
			for (let node = el.parentElement; node && node !== this; node = node.parentElement) {
				if (node.tagName !== 'FIELDSET') continue;
				const marker = node.getAttribute('is');
				if (marker === 'request-header' || marker === 'query-param') { headerBound = true; break; }
				// unshift: the walk runs inward-out, the grammar reads outward-in.
				if (marker === 'name-space' && node.getAttribute('name')) groups.unshift(node.getAttribute('name'));
			}
			if (headerBound || !groups.length) continue;
			renamed.push([el, el.name]);
			el.name = groups[0] + [...groups.slice(1), el.name].map(part => `[${part}]`).join('');
		}
		return renamed;
	}

	collectFormData() {
		// The rename below is made to the live DOM, so undoing it is not
		// optional — the `finally` is what keeps a throw anywhere in between
		// from leaving the page renamed. Both the FormData construction AND
		// the PATCH dirty filter sit inside that window, because dirtyByName
		// is keyed by NAME: filtering renamed wire keys against un-renamed DOM
		// names would drop every namespaced field, and two same-named fields
		// in different groups would land in one bucket — the very ambiguity
		// this exists to make impossible. A rename touches neither
		// defaultValue nor defaultChecked nor defaultSelected, so dirtiness
		// reads exactly as it did before.
		const renamed = this._applyNamespaces();
		try {
			const formData = new FormData(this, this._submitter);
			// A submit button that shares its `name` with another form control
			// appears TWICE in the entry list (the control's value + the
			// submitter's). A single-valued server struct rejects the repeat
			// ("duplicate field `x`"). Collapse to one entry carrying the
			// submitter's value (the action intent).
			const sName = this._submitter?.name;
			if (sName && formData.getAll(sName).length > 1) {
				formData.set(sName, this._submitter.value);
			}
			for (const name of this.getHeaderBoundFields()) formData.delete(name);

			// A query-param fieldset's controls are its template's variables:
			// they leave the entry list, and the pair they compose joins it.
			for (const name of this.getComposedFields()) formData.delete(name);
			const composed = [];
			for (const qp of this._queryParams()) {
				const pair = qp.computePair(this._wireName(qp, qp.key));
				if (pair) {
					formData.append(...pair);
					composed.push([pair[0], qp]);
				}
			}

			// PATCH method emits a dirty-only body: every form control whose value
			// matches its server-rendered default is dropped. The browser tracks
			// the default natively via defaultValue / defaultChecked /
			// defaultSelected, so there is no shadow state to maintain — after a
			// successful PATCH the swapped-in partial replaces the controls and
			// the new wire values become the new defaults automatically.
			// RFC 5789: PATCH bodies describe deltas, not the full resource.
			// Raw getAttribute (not the formMethod IDL property): the IDL property
			// is spec-defined as "limited to only known values" and normalizes
			// anything other than GET/POST/dialog to the missing-value default of
			// "get" — so submitter.formMethod on <button formmethod="PATCH"> would
			// silently return "get". getAttribute returns the raw string.
			const method = (this._submitter?.getAttribute('formmethod') || this.getAttribute('method') || 'GET').toUpperCase();
			if (method === 'PATCH') {
				const dirtyByName = new Map();
				for (const el of this.elements) {
					if (!el.name || el.disabled) continue;
					if (HTTPAwareForm._isDirty(el)) {
						if (!dirtyByName.has(el.name)) dirtyByName.set(el.name, []);
						dirtyByName.get(el.name).push(el);
					}
				}
				// A composed pair is dirty when any control it is composed from is.
				for (const [key, qp] of composed) {
					if (qp.inputs.some(el => !el.disabled && HTTPAwareForm._isDirty(el))) dirtyByName.set(key, [qp]);
				}
				// The submitter's own name/value is the ACTION intent (e.g. a
				// <button name="is_primary" value="true"> in the comparison view),
				// not a dirty-able field — always keep it. A <button> is never
				// "dirty" (nor is a constant hidden input), so exempting the
				// submitter's name is the only way a PATCH action-button delivers
				// its value under the dirty-only filter.
				const submitterName = this._submitter?.name || null;
				// Drop any field that isn't dirty. Keep ones that are dirty as-is
				// (FormData already contains their current values).
				for (const name of [...formData.keys()]) {
					if (name === submitterName) continue;
					if (!dirtyByName.has(name)) formData.delete(name);
				}
			}
			// Names actually on the wire — the response-side morph lets the server
			// echo win for exactly these fields (a clamped/quantized commit must
			// display), while other dirty fields keep their unsubmitted edits.
			this._lastSubmittedNames = new Set(formData.keys());
			// Read inside the rename window, so a namespaced control owns its
			// WIRE name — the one the query merge in buildRequest compares.
			this._ownedKeys = this._ownedQueryKeys();
			return formData;
		} finally {
			for (const [el, name] of renamed) el.name = name;
		}
	}

	/**
	 * The keys this form states in a query: the name of every submittable
	 * control associated with it. A control owns its key whether or not it
	 * submits anything this time — an unchecked box, an empty multi-select, a
	 * disabled field, a button that is not the submitter — because a form that
	 * CAN state a key is the authority on it, and its silence says "none". Were
	 * ownership read off the submitted pairs instead, unchecking the last box of
	 * a key would leave the action's copy of that key in place, and the value
	 * could never be withdrawn. An image button owns the two coordinate keys it
	 * would send. A query-param fieldset owns the key it names — composed or
	 * not, like any control — and the controls inside it own nothing, because
	 * their names are the template's variables rather than keys of the query.
	 */
	_ownedQueryKeys() {
		const keys = new Set();
		const queryParams = this._queryParams();
		const variables = new Set(queryParams.flatMap(qp => qp.inputs));
		for (const qp of queryParams) {
			if (qp.key) keys.add(this._wireName(qp, qp.key));
		}
		for (const el of this.elements) {
			if (!el.name || variables.has(el)) continue;
			if (!SUBMITTABLE.has(el.tagName) && !el.constructor?.formAssociated) continue;
			if (el.tagName === 'INPUT' && el.type === 'image') {
				keys.add(`${el.name}.x`);
				keys.add(`${el.name}.y`);
			} else {
				keys.add(el.name);
			}
		}
		return keys;
	}

	/**
	 * An explicit action's query, overlaid by the form. Every pair of the
	 * action's query whose key the form owns is dropped; the rest are kept
	 * byte-exact and in their order; the form's own pairs follow. It is
	 * Object.assign over an ordered multimap: repeated keys survive on both
	 * sides, and the form wins on every key it names.
	 *
	 * Kept pairs are copied as raw segments rather than parsed and
	 * re-serialised, because re-serialising is not neutral — `%20` would come
	 * back as `+`, and a server that treats the query as an identity (a cache
	 * key, a canonical address) would see a different URL for the same request.
	 */
	static mergeQuery(search, owned, pairs) {
		const kept = search.replace(/^\?/, '').split('&').filter(segment =>
			segment && !owned.has(HTTPAwareForm._decodeKey(segment.split('=', 1)[0]))
		);
		const added = pairs.toString();
		return [...kept, ...(added ? [added] : [])].join('&');
	}

	static _decodeKey(raw) {
		try { return decodeURIComponent(raw.replace(/\+/g, ' ')); } catch { return raw; }
	}

	/**
	 * Native dirty detection — every form control exposes its server-rendered
	 * default via the DOM. No baseline tracking, no MutationObserver, no
	 * client-held shadow state. Honors HATEOAS: the server's representation
	 * is the source of truth; "dirty" simply means "diverged from what the
	 * server last sent".
	 */
	static _isDirty(el) {
		if (el.type === 'checkbox' || el.type === 'radio') {
			return el.checked !== el.defaultChecked;
		}
		if (el.tagName === 'SELECT') {
			return [...el.options].some(o => o.selected !== o.defaultSelected);
		}
		if (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT') {
			return el.value !== el.defaultValue;
		}
		return false;
	}

	/**
	 * In-place DOM morph — reconcile `live` to match `fresh` without tearing
	 * out surviving nodes. The focused input keeps its NODE IDENTITY (caret,
	 * selection, scroll position, an open popover) — which is the point: the
	 * outerHTML swap's capture/restore dance is unnecessary on morphed targets.
	 * Opt-in per swap (`target="#x@morph"`, or `data-swap="morph"` on an OOB /
	 * SSE-pushed root). Proven first on a live-recalculating panel whose
	 * response replaces the whole form (2026-07-19).
	 *
	 * Form-control value semantics:
	 *  - attributes always sync (value attr == the server's new DEFAULT, so
	 *    native dirty-tracking stays coherent after the morph)
	 *  - the value PROPERTY follows the server render EXCEPT:
	 *      · the active element is never written (the user is mid-edit)
	 *      · a dirty control keeps its unsubmitted local edit UNLESS this
	 *        response just processed that very field (`submitted` set) — then
	 *        the server echo wins (a clamped/quantized commit must display).
	 *
	 * Falls back to outerHTML + capture/restore on shape mismatch or any error
	 * mid-morph — never leaves a half-updated panel.
	 */
	static morphSwap(live, fresh, submitted) {
		if (fresh && fresh.nodeType === 1 && fresh.tagName === live.tagName) {
			try {
				HTTPAwareForm._morphEl(live, fresh, submitted || null);
				return;
			} catch (err) {
				console.error('http-aware: morph failed, falling back to replace', err);
			}
		}
		const state = HTTPAwareForm.captureEditState(live);
		live.outerHTML = fresh ? fresh.outerHTML : '';
		HTTPAwareForm.restoreEditState(state);
	}

	static _morphEl(live, fresh, submitted) {
		for (const attr of fresh.attributes) {
			if (live.getAttribute(attr.name) !== attr.value) live.setAttribute(attr.name, attr.value);
		}
		for (const attr of [...live.attributes]) {
			if (!fresh.hasAttribute(attr.name)) live.removeAttribute(attr.name);
		}
		const tag = live.tagName;
		if (tag === 'INPUT' || tag === 'TEXTAREA') {
			const active = live === document.activeElement;
			const echoed = !!submitted && submitted.has(live.name);
			// _isDirty AFTER the attr sync above = "differs from what the server
			// just sent" — exactly the unsubmitted edit worth protecting.
			if (!active && (echoed || !HTTPAwareForm._isDirty(live))) {
				if (live.type === 'checkbox' || live.type === 'radio') {
					if (live.checked !== fresh.checked) live.checked = fresh.checked;
				} else if (live.value !== fresh.value) {
					live.value = fresh.value;
				}
			}
		}
		HTTPAwareForm._morphChildren(live, fresh, submitted);
		// SELECT selectedness after its options were morphed above.
		if (tag === 'SELECT' && live !== document.activeElement
			&& ((!!submitted && submitted.has(live.name)) || !HTTPAwareForm._isDirty(live))) {
			for (const opt of live.options) {
				const want = opt.hasAttribute('selected');
				if (opt.selected !== want) opt.selected = want;
			}
		}
	}

	static _morphChildren(live, fresh, submitted) {
		const liveKids = [...live.childNodes];
		const liveById = new Map();
		for (const n of liveKids) {
			if (n.nodeType === 1 && n.id) liveById.set(n.id, n);
		}
		const used = new Set();
		let cursor = null; // last placed node; the next insertion anchor is its nextSibling
		for (const f of fresh.childNodes) {
			let match = null;
			if (f.nodeType === 1 && f.id && liveById.has(f.id)) {
				match = liveById.get(f.id);
			} else {
				for (const n of liveKids) {
					if (used.has(n) || n.nodeType !== f.nodeType) continue;
					if (n.nodeType === 1) {
						if (n.tagName !== f.tagName) continue;
						// A keyed live node only pairs with its own key.
						if (n.id && (!f.id || f.id !== n.id)) continue;
					}
					match = n;
					break;
				}
			}
			if (match) {
				used.add(match);
				const anchor = cursor ? cursor.nextSibling : live.firstChild;
				// Moving a node blurs a focused descendant. Server renders are
				// order-stable, so match !== anchor only means unmatched nodes
				// sit between (removed below) — skip the move when it would
				// touch the focused subtree.
				if (match !== anchor && !(match.nodeType === 1 && match.contains(document.activeElement))) {
					live.insertBefore(match, anchor);
				}
				if (f.nodeType === 1) {
					HTTPAwareForm._morphEl(match, f, submitted);
				} else if (match.nodeValue !== f.nodeValue) {
					match.nodeValue = f.nodeValue;
				}
				cursor = match;
			} else {
				const clone = f.cloneNode(true);
				live.insertBefore(clone, cursor ? cursor.nextSibling : live.firstChild);
				used.add(clone);
				cursor = clone;
			}
		}
		for (const n of liveKids) {
			if (used.has(n)) continue;
			// Never remove the subtree holding the focused element.
			if (n.nodeType === 1 && n.contains(document.activeElement)) continue;
			n.remove();
		}
	}

	/**
	 * Capture the user's edit state inside `container` before a swap replaces
	 * it: dirty descendants (edits the server does not know about yet — under
	 * commit-point autosubmit these legitimately exist between commits) and
	 * the focused element's id + caret. Restore with restoreEditState after
	 * the swap; elements are re-found by id, so the incoming render must keep
	 * stable ids (server-rendered partials do). Shared by swapResponse here
	 * and any out-of-band swap handler a host installs — ONE mechanism.
	 * Returns null when there is nothing to preserve.
	 */
	static captureEditState(container) {
		if (!container || !container.querySelectorAll) return null;
		const state = { dirty: [], refocus: null };
		const active = document.activeElement;
		if (active && active.id && container.contains(active)) {
			state.refocus = { id: active.id, start: null, end: null };
			// selectionStart throws on number/select inputs — best-effort.
			try { state.refocus.start = active.selectionStart; state.refocus.end = active.selectionEnd; } catch (_) {}
		}
		for (const el of container.querySelectorAll('input, select, textarea')) {
			if (!el.id || !HTTPAwareForm._isDirty(el)) continue;
			if (el.type === 'checkbox' || el.type === 'radio') {
				state.dirty.push({ id: el.id, checked: el.checked });
			} else {
				state.dirty.push({ id: el.id, value: el.value });
			}
		}
		return (state.dirty.length || state.refocus) ? state : null;
	}

	/** Re-apply a captureEditState snapshot after a swap. The server render
	 *  stays authoritative for everything that was not dirty; restoring a
	 *  value the render already carries is a no-op (value === defaultValue,
	 *  no longer dirty). Focus/caret only move if the swap disturbed them. */
	static restoreEditState(state) {
		if (!state) return;
		for (const saved of state.dirty) {
			const el = document.getElementById(saved.id);
			if (!el) continue;
			if ('checked' in saved) el.checked = saved.checked;
			else el.value = saved.value;
		}
		if (state.refocus) {
			const el = document.getElementById(state.refocus.id);
			if (el && document.activeElement !== el) {
				el.focus();
				if (state.refocus.start != null) {
					try { el.setSelectionRange(state.refocus.start, state.refocus.end); } catch (_) {}
				}
			}
		}
	}

	encodeBody(formData, enctype) {
		if (enctype === 'text/plain') return [...formData].map(([k, v]) => `${k}=${v}`).join('\r\n');
		if (enctype === 'application/x-www-form-urlencoded') return new URLSearchParams([...formData].filter(([, v]) => !(v instanceof File)));
		return formData; // multipart/form-data
	}

	/** Parse target string: "#selector@swapStyle" → { selector, swap } */
	parseTarget(raw) {
		if (!raw) return null;
		const at = raw.lastIndexOf('@');
		if (at > 0) return { selector: raw.slice(0, at), swap: raw.slice(at + 1) };
		return { selector: raw, swap: 'innerHTML' };
	}

	/** Effective target — submitter's formtarget overrides form's target.
	 *  Raw getAttribute (not the formTarget IDL property) for uniformity with
	 *  the formmethod / formaction reads below — see notes there. The IDL
	 *  property would be safe here, but mixing styles invites the reader to
	 *  "clean up" the other two into property reads and reintroduce their
	 *  spec gotchas. Keep the pattern uniform. */
	get effectiveTarget() {
		return this.parseTarget(this._submitter?.getAttribute('formtarget') || this.getAttribute('target'));
	}

	buildRequest() {
		// See collectFormData for why getAttribute('formmethod') instead of formMethod IDL.
		const method = (this._submitter?.getAttribute('formmethod') || this.getAttribute('method') || 'GET').toUpperCase();
		const headers = this.collectHeaders();
		const formData = this.collectFormData();
		// Raw getAttribute (not the formAction IDL property): the IDL property
		// returns document.URL when the attribute is missing or empty, so
		// there is no way to tell "no formaction set" apart from "formaction
		// equals the current page." getAttribute returns null when unset and
		// the relative URL otherwise; new URL(...) below resolves it.
		const action = this._submitter?.getAttribute('formaction') || this.getAttribute('action') || '';
		const url = new URL(action || location.href, location.origin);
		let body = null;

		if (['GET', 'HEAD', 'DELETE'].includes(method)) {
			const pairs = new URLSearchParams([...formData].map(([k, v]) => [k, v instanceof File ? v.name : v]));
			// An EXPLICIT action is a URL the author wrote, query and all, so the
			// form is merged into it rather than written over it. An empty or
			// absent action is the platform's case — the form submits to the
			// document's own address, whose query is the previous submission's —
			// and keeps the platform's replacement, which is what stops a
			// self-submitting search box accumulating `q=…&q=…` on every send.
			// See docs/decisions/ADR-2026.09.23.explicit-action-query-merges.md
			url.search = action.trim() ? HTTPAwareForm.mergeQuery(url.search, this._ownedKeys, pairs) : pairs;
		} else {
			body = this.encodeBody(formData, this._submitter?.formEnctype || this.enctype || 'application/x-www-form-urlencoded');
		}

		// Anything else a host or an interop layer wants on the wire. The core
		// sends nothing it did not read off this form.
		for (const hook of HTTPAwareForm.requestHooks) hook(headers, this);

		return new Request(url.href, { method, headers, body, redirect: 'follow' });
	}

	async swapResponse(response) {
		// 204 No Content: the server explicitly said "nothing to show" — the
		// visible change (if any) arrives out of band. Without this
		// guard a 204 with a target= would swap the empty body in and wipe the
		// target (e.g. a DELETE on the toolbar form whose target is the dialog).
		// Mirrors the same guard in navigateWithResponse (the no-target path).
		if (response.status === 204) return;
		// Non-OK responses: only text/html bodies may swap (the 401
		// login-page-as-body is a house auth pattern and must keep working).
		// Anything else — bad_request JSON, plain-text errors — must NOT
		// replace the target: swapping a 400 body as outerHTML deleted the
		// panel it was reporting about (observed 2026-07-16). Surface it
		// instead: toast + bubbled event.
		if (!response.ok) {
			const ctype = response.headers.get('content-type') || '';
			if (!ctype.includes('text/html')) {
				let message = '';
				try {
					const text = await response.text();
					try { message = JSON.parse(text).message || text; } catch { message = text; }
				} catch { /* body unreadable — status alone will have to do */ }
				console.error('http-aware: request failed', response.status, message);
				// The event is the whole mechanism: it is cancelable so a
				// consumer rendering its own inline error can preventDefault()
				// and suppress whatever fallback the host installs. The library
				// itself shows nothing — it has no business assuming a host UI.
				const errEvent = new CustomEvent('http-aware-error', {
					detail: { status: response.status, message },
					bubbles: true,
					cancelable: true,
				});
				this.dispatchEvent(errEvent);
				return;
			}
		}
		// The server may redirect the swap per response. Header NAMES are
		// configurable so an interop layer can accept another library's
		// spelling; when absent, the form's own target= attribute stands.
		const retarget = HTTPAwareForm.header(response, HTTPAwareForm.retargetHeaders);
		const reswap   = HTTPAwareForm.header(response, HTTPAwareForm.reswapHeaders);
		const t = this.effectiveTarget;
		const target = retarget
			? document.querySelector(retarget)
			: (t && document.querySelector(t.selector));
		if (!target) {
			console.error('http-aware: target not found:', retarget || t?.selector);
			return;
		}
		const swap = reswap || t?.swap || 'innerHTML';

		const html = await response.text();

		// Parse response into fragment to detect OOB elements
		const tpl = document.createElement('template');
		tpl.innerHTML = html;
		// Unwrap top-level <template> wrappers that shield out-of-band content from
		// table-context foster-parenting. A response whose PRIMARY content is table rows
		// (<tr>…) is parsed in table context; a trailing OOB <menu>/<div> full of <form>s
		// would be foster-parented there, GUTTING each form (its controls become siblings of
		// an emptied form → FormData empty, submit button orphaned). Server templates wrap such
		// OOB in <template> so it parses inertly, so look inside them here — only
		// those that actually carry OOB, leaving literal <template> content
		// untouched. Found with popover menus delivered OOB.
		const children = [];
		for (const node of [...tpl.content.children]) {
			if (node.tagName === 'TEMPLATE' && node.content.querySelector(HTTPAwareForm.oobSelector)) {
				children.push(...node.content.children);
			} else {
				children.push(node);
			}
		}

		// Separate primary target content from OOB elements.
		// When the server retargeted, the whole payload is meant for
		// that target — skip the auto-OOB heuristic, otherwise children
		// that share an id with existing DOM nodes (the common case for a
		// full-container refresh) get yanked out and the primary swap ends
		// up wiping the container.
		const primaryParts = [];
		const primaryElements = [];
		// A child whose id already exists INSIDE the target is NOT out-of-band.
		// A primary innerHTML/outerHTML swap destroys the target's content, so an
		// in-place replacement there is wiped a few lines later -- and the child is
		// not part of the primary payload either, so it is simply lost. Insertion
		// swaps keep the target's content, so the heuristic stands for them.
		const primaryWipesTarget = swap === 'innerHTML' || swap === 'outerHTML'
			|| !['beforebegin', 'afterbegin', 'beforeend', 'afterend', 'delete', 'none', 'morph'].includes(swap);
		const oobTargets = [];
		if (retarget) {
			for (const child of children) {
				primaryParts.push(child.outerHTML);
				primaryElements.push(child);
			}
		} else {
			for (const child of children) {
				const existing = child.id ? document.getElementById(child.id) : null;
				const insideTarget = !!existing && primaryWipesTarget && target.contains(existing);
				if (existing && child.id !== target.id && !insideTarget) {
					const oobTarget = existing;
					if (child.getAttribute('data-swap') === 'morph') {
						// Morph-marked OOB root: reconcile in place;
						// per-field dirty/focus protection lives inside
						// the morph.
						HTTPAwareForm.morphSwap(oobTarget, child, this._lastSubmittedNames);
					} else {
						// Preserve in-flight edits + focus through the OOB replace.
						const oobState = HTTPAwareForm.captureEditState(oobTarget);
						oobTarget.outerHTML = child.outerHTML;
						HTTPAwareForm.restoreEditState(oobState);
					}
					// Report the freshly-swapped node on the swapped event, so an
					// interop layer can wire up whatever markup it owns.
					const replaced = document.getElementById(child.id);
					if (replaced) oobTargets.push(replaced);
				} else {
					primaryParts.push(child.outerHTML);
					primaryElements.push(child);
				}
			}
		}

		// innerHTML means the target's INNER HTML. A response whose primary content is one
		// element carrying the target's own id is a new edition of the target — the partial
		// renders the whole panel so that its route is addressable on its own — and its inner
		// HTML is what replaces the target's; the element itself does not go inside. Placing
		// it inside would nest the target in itself, duplicate id and all; `beforeend` and its
		// siblings are the styles that insert. Matched on id only, deliberately: any other
		// response is placed as it always was.
		// See: docs/decisions/ADR-2026.09.24.innerhtml-takes-the-edition.md
		const edition = swap === 'innerHTML' && primaryElements.length === 1
			&& primaryElements[0].id && primaryElements[0].id === target.id;
		const primaryHtml = edition ? primaryElements[0].innerHTML : primaryParts.join('');
		// Capture the parent BEFORE the swap: outerHTML/beforebegin/afterend
		// insert the new node(s) as siblings, so the inserted content is reached
		// via the parent, not via `target` (which outerHTML detaches entirely).
		const targetParent = target.parentNode;
		// innerHTML/outerHTML destroy the target's current content — carry the
		// user's unsubmitted edits + focus across (insertion swaps don't touch
		// existing content, and delete/none replace nothing).
		// morph reconciles in place — nodes survive, so there is nothing to
		// capture/restore (that dance exists to survive teardown).
		const primaryState = (swap === 'innerHTML' || swap === 'outerHTML' || !['beforebegin', 'afterbegin', 'beforeend', 'afterend', 'delete', 'none', 'morph'].includes(swap))
			? HTTPAwareForm.captureEditState(target)
			: null;
		switch (swap) {
			case 'innerHTML': target.innerHTML = primaryHtml; break;
			case 'outerHTML': target.outerHTML = primaryHtml; break;
			case 'beforebegin': target.insertAdjacentHTML('beforebegin', primaryHtml); break;
			case 'afterbegin': target.insertAdjacentHTML('afterbegin', primaryHtml); break;
			case 'beforeend': target.insertAdjacentHTML('beforeend', primaryHtml); break;
			case 'afterend': target.insertAdjacentHTML('afterend', primaryHtml); break;
			case 'delete': target.remove(); break;
			case 'none': break;
			case 'morph': {
				// In-place reconcile: the focused input, its caret, and any
				// open popover survive because their nodes are never replaced.
				const mtpl = document.createElement('template');
				mtpl.innerHTML = primaryHtml;
				if (mtpl.content.children.length === 1) {
					HTTPAwareForm.morphSwap(target, mtpl.content.firstElementChild, this._lastSubmittedNames);
				} else {
					// Multi-root payload — morph contract is single-root; take
					// the old replacement path with its preservation dance.
					const st = HTTPAwareForm.captureEditState(target);
					target.outerHTML = primaryHtml;
					HTTPAwareForm.restoreEditState(st);
				}
				break;
			}
			default: target.innerHTML = primaryHtml;
		}
		HTTPAwareForm.restoreEditState(primaryState);

		// Where the swapped content actually landed. 'delete' removes the node
		// and 'none' inserts nothing, so there is nothing to report;
		// outerHTML/beforebegin/afterend land their nodes as SIBLINGS, so the
		// parent is the root, while innerHTML/afterbegin/beforeend land inside
		// the target. Reported on the event below rather than walked here — the
		// library has no markup of its own to wire up.
		let swapRoot = null;
		if (swap !== 'delete' && swap !== 'none') {
			const sibling = swap === 'outerHTML' || swap === 'beforebegin' || swap === 'afterend';
			swapRoot = (sibling ? targetParent : target) || null;
		}

		// Post-swap notification, and the library's single seam for anything that
		// must run over freshly-swapped markup: a script re-initialising controls,
		// or an interop layer wiring up another library's attributes. Deliberately
		// a name of our own — synthesising some other library's event would wake
		// every listener it has with a detail shape we do not honour.
		document.dispatchEvent(new CustomEvent('http-aware:swapped', {
			bubbles: true,
			detail: { target, swapRoot, oobTargets, response },
		}));
	}

	async navigateWithResponse(response, method, target = '_self') {
		// 204 No Content: the server explicitly said "nothing to show."
		// Return silently — the visible effect (if any) flowed via SSE or
		// another out-of-band channel.
		if (response.status === 204) return;

		// 4xx / 5xx: the server returned an error. Navigating to the URL
		// would replace the page with the error body (or worse, the URL the
		// browser falls back to). Fire an `http-error` event so the page
		// can react, and log the response — do NOT navigate. This blocks
		// the class of bugs where a malformed body (e.g. multi-valued field
		// rejected as 400) leaks into a browser navigation.
		if (response.status >= 400) {
			let bodyText = '';
			try { bodyText = await response.text(); } catch {}
			this.dispatchEvent(new CustomEvent('http-error', {
				bubbles: true,
				detail: { status: response.status, url: response.url, body: bodyText, method },
			}));
			console.error('http-aware: server returned', response.status, 'for', method, response.url, bodyText.substring(0, 200));
			return;
		}

		if (!response.redirected && (response.headers.get('content-type') || '').includes('text/html')) {
			const w = (target === '_blank') ? window.open('', '_blank').document : document;

			w.open().write(await response.text()); w.close(); if (target!=='_blank') history.pushState(null, '', response.url);
		} else if (target === '_blank') window.open(response.url);
		else location.href = response.url;
	}

	handleError(error) {
		this.dispatchEvent(new CustomEvent('http-error', { bubbles: true, detail: { error } }));
		console.error('http-aware error:', error);
	}

	submit() {
		const request = this.buildRequest();
		const t = this.effectiveTarget;
		fetch(request)
			.then(res => t ? this.swapResponse(res) : this.navigateWithResponse(res, request.method, this.target || '_self'))
			.catch(err => this.handleError(err));
	}

	/**
	 * Cancel any pending per-input debounce timers, then submit. Use from
	 * JS when you want the explicit "save now" semantic — the declarative
	 * equivalent is `<button type="submit" formdebounce="0">` inside the
	 * form. Either path cancels in-flight typing timers so the explicit
	 * submission isn't followed by a redundant debounced one.
	 */
	flush() {
		if (this._debounceTimers) {
			for (const el of this.elements) {
				const timer = this._debounceTimers.get(el);
				if (timer) { clearTimeout(timer); this._debounceTimers.delete(el); }
			}
		}
		this.requestSubmit();
	}

	requestSubmit(submitter = null) {
		// Abort any in-flight request from this form
		if (this._abortController) this._abortController.abort();
		this._abortController = new AbortController();

		this._submitter = submitter;
		// Sync same-named control with submitter value (FormData doesn't override, just adds both)
		if (submitter?.name) {
			for (const el of this.elements) {
				if (el.name === submitter.name && el !== submitter && !(el instanceof HTMLButtonElement)) {
					el.value = submitter.value;
					break;
				}
			}
		}

		// `formdebounce` on the submitter mirrors the formaction/formmethod
		// override pattern: a button can locally override the form's
		// `debounce` for THIS submission. Presence of the attribute clears
		// any pending per-input debounce timers so the explicit click flushes
		// ahead of any in-flight typing debounce. Today only the "flush now"
		// semantic is wired (any value clears); per-button non-zero overrides
		// are reserved for future use without changing the wire shape.
		if (submitter?.hasAttribute('formdebounce') && this._debounceTimers) {
			for (const el of this.elements) {
				const timer = this._debounceTimers.get(el);
				if (timer) { clearTimeout(timer); this._debounceTimers.delete(el); }
			}
		}

		const shouldValidate = !(this.noValidate || submitter?.formNoValidate);
		if (shouldValidate && !this.checkValidity()) { this.reportValidity(); return; }

		this.preparedRequest = this.buildRequest();
		const t = this.effectiveTarget;

		// We intentionally do NOT dispatch a synthetic submit event here.
		// In Chromium, the default action of a submit event (native form
		// submission, which falls back to GET for PATCH/PUT/DELETE methods)
		// fires even on synthetic events unless preventDefault is called.
		// If we dispatch + don't preventDefault, the browser submits natively
		// in parallel with our fetch — observed as a toggle that navigated
		// the page instead of fetching. If we
		// preventDefault internally, external listeners' preventDefault is
		// indistinguishable, so the form's own opt-out becomes unreliable.
		// External code that wants to know about programmatic submits can
		// listen for our `http-aware-submitted` custom event below.
		this.dispatchEvent(new CustomEvent('http-aware-submitted', {
			detail: { method: this.preparedRequest.method, url: this.preparedRequest.url },
			bubbles: true,
		}));

		const method = this.preparedRequest.method;
		fetch(this.preparedRequest, { signal: this._abortController.signal })
			.then(res => t ? this.swapResponse(res) : this.navigateWithResponse(res, method, this.target || '_self'))
			.catch(err => { if (err.name !== 'AbortError') this.handleError(err); });
		this.preparedRequest = null;
	}

}
customElements.define('http-aware', HTTPAwareForm, { extends: 'form' });

if (typeof module !== 'undefined' && module.exports) {
	module.exports = { RequestHeader, HTTPAwareForm };
}
