// HTTP-Aware Forms — htmx interoperability (optional)
// Load AFTER http-aware.js, and only on pages that also run htmx.
//
// http-aware and htmx do the same kind of work and can share a page, usually
// because one is being migrated to the other. This file is the whole of what
// each needs to know about the other, kept out of the core so that a project
// using only http-aware carries none of it.
//
// It teaches http-aware four things:
//
//   1. `hx-swap-oob` marks an out-of-band element (http-aware's own is
//      `data-swap-oob`).
//   2. `HX-Retarget` and `HX-Reswap` may redirect a swap, alongside
//      `X-Retarget` / `X-Reswap`.
//   3. Send `HX-Request: true` on a partial request, which is what a server
//      written for htmx branches on.
//   4. Run `htmx.process` over freshly-swapped markup so hx-* inside it goes
//      live, and honour `HX-Push-Url`.
//
// None of that belongs in a library that is not htmx.

(() => {
	if (typeof HTTPAwareForm === 'undefined') {
		console.error('http-aware-htmx: load http-aware.js first.');
		return;
	}

	// 1 + 2 — recognise htmx's spellings alongside our own.
	HTTPAwareForm.oobAttributes.push('hx-swap-oob');
	HTTPAwareForm.retargetHeaders.push('HX-Retarget');
	HTTPAwareForm.reswapHeaders.push('HX-Reswap');

	// 3 — announce a partial request the way an htmx-shaped server expects.
	HTTPAwareForm.requestHooks.push((headers, form) => {
		const t = form.effectiveTarget;
		if (t?.selector.startsWith('#') || t?.selector.startsWith('.')) {
			headers.push(['HX-Request', 'true']);
		}
	});

	// Attributes worth a walk. htmx.process is not free, and most swaps on a
	// migrating page carry no htmx markup at all, so check before walking.
	const HX_MARKUP = [
		'hx-get', 'hx-post', 'hx-put', 'hx-patch', 'hx-delete',
		'hx-boost', 'hx-trigger', 'hx-swap-oob', 'hx-ext',
	].map(a => `[${a}]`).join(',');

	const carriesHtmx = (root) =>
		root instanceof Element && (root.matches(HX_MARKUP) || root.querySelector(HX_MARKUP));

	// 4 — wire up swapped content, and honour the push-url header.
	document.addEventListener('http-aware:swapped', (event) => {
		const { swapRoot, oobTargets = [], response } = event.detail || {};

		if (typeof htmx !== 'undefined') {
			for (const root of [swapRoot, ...oobTargets]) {
				// A subtree fenced with hx-disable is htmx's own opt-out and it
				// honours it natively; the guard here is only about the cost of
				// walking markup that has no hx-* in it at all.
				if (root?.isConnected && carriesHtmx(root)) htmx.process(root);
			}
		}

		const pushUrl = response?.headers?.get('HX-Push-Url');
		if (pushUrl && pushUrl !== 'false') history.pushState({}, '', pushUrl);
	});
})();
