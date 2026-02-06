// HTTP-Aware Forms v1.0 - Expand HTML forms' HTTP methods and header declarations.
// https://github.com/avnc/http-aware | MIT License | RFC 9110 compliant

const COMBINABLE_HEADERS = new Set([
	'accept', 'accept-charset', 'accept-encoding', 'accept-language',
	'cache-control', 'connection', 'content-encoding', 'expect',
	'if-match', 'if-none-match', 'prefer', 'te', 'trailer',
	'transfer-encoding', 'upgrade', 'via', 'warning', 'link'
]);

class RequestHeader extends HTMLFieldSetElement {
	static get observedAttributes() { return ['header', 'value']; }

	get header() { return this.getAttribute('header') || ''; }

	get template() { return this.getAttribute('value') || ''; }

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
		result = result.replace(/\{([a-zA-Z_][a-zA-Z0-9_-]*)(?:,([^}]+))?\}/g, (match, name, fmt) => {
			return name in values ? this.form.formatValue(values[name], fmt) : match;
		});
		return result.replace(/\x00O\x00/g, '{').replace(/\x00C\x00/g, '}');
	}

	computeValue() {
		const result = this.interpolate(this.template, this.values);
		return result && !/^[a-zA-Z_-]+=\s*$/.test(result) ? result : '';
	}
}
customElements.define('request-header', RequestHeader, { extends: 'fieldset' });

class HTTPAwareForm extends HTMLFormElement {
	static formatters = {};

	formatValue(value, formatSpec) {
		value = value ?? '';
		const m = formatSpec?.match(/^(\w+)(?:\(([^)]*)\))?$/);
		return HTTPAwareForm.formatters[m?.[1]]?.(value, ...m?.[2]?.split(',').map(a => a.trim()) ?? []) ?? String(value);
	}

	preparedRequest = null;

	connectedCallback() {
		this.addEventListener('submit', this._handleNativeSubmit.bind(this));
	}

	_handleNativeSubmit(event) {
		if (!event._httpAware) { event.preventDefault(); event.stopPropagation(); this.requestSubmit(event.submitter); }
	}

	getHeaderBoundFields() {
		return new Set([...this.querySelectorAll('fieldset[is="request-header"]')].flatMap(el => el.inputs.flatMap(i=>i.name?[i.name]:[])));
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

	collectFormData() {
		const formData = new FormData(this, this._submitter);
		for (const name of this.getHeaderBoundFields()) formData.delete(name);
		return formData;
	}

	encodeBody(formData, enctype) {
		if (enctype === 'text/plain') return [...formData].map(([k, v]) => `${k}=${v}`).join('\r\n');
		if (enctype === 'application/x-www-form-urlencoded') return new URLSearchParams([...formData].filter(([, v]) => !(v instanceof File)));
		return formData; // multipart/form-data
	}

	buildRequest() {
		const method = (this._submitter?.formMethod || this.getAttribute('method') || 'GET').toUpperCase();
		const headers = this.collectHeaders();
		const formData = this.collectFormData();
		const url = new URL((this._submitter?.hasAttribute('formaction') ? this._submitter.formAction : null) || this.action || location.href, location.origin);
		let body = null;

		if (['GET', 'HEAD', 'DELETE'].includes(method)) {
			url.search = new URLSearchParams([...formData].map(([k, v]) => [k, v instanceof File ? v.name : v]));
		} else {
			body = this.encodeBody(formData, this._submitter?.formEnctype || this.enctype || 'application/x-www-form-urlencoded');
		}

		return new Request(url.href, { method, headers, body, redirect: 'follow' });
	}

	async navigateWithResponse(response, method, target = '_self') {
		if (response.status === 204) console.warn('http-aware: 204 No Content for', method, response.url);

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
		const target = this.target || '_self';
		fetch(request)
			.then(res => this.navigateWithResponse(res, request.method, target))
			.catch(err => this.handleError(err));
	}

	requestSubmit(submitter = null) {
		this._submitter = submitter;
		const shouldValidate = !(this.noValidate || submitter?.formNoValidate);
		if (shouldValidate && !this.checkValidity()) { this.reportValidity(); return; }

		this.preparedRequest = this.buildRequest();
		const target = submitter?.formTarget || this.target || '_self';
		const event = new SubmitEvent('submit', { submitter, bubbles: true, cancelable: true });
		event._httpAware = true;

		if (this.dispatchEvent(event)) {
			const method = this.preparedRequest.method;
			fetch(this.preparedRequest)
				.then(res => this.navigateWithResponse(res, method, target))
				.catch(err => this.handleError(err));
		}
		this.preparedRequest = null;
	}

}
customElements.define('http-aware', HTTPAwareForm, { extends: 'form' });

if (typeof module !== 'undefined' && module.exports) {
	module.exports = { RequestHeader, HTTPAwareForm };
}
