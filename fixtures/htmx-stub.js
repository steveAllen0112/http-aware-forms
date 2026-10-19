// A stand-in for htmx, for the cases that test http-aware-htmx.js. It records
// the id of each element handed to htmx.process and does nothing else, so a
// case can state which swapped elements the interop gave to htmx. Whether htmx
// then wires the hx-* inside them is htmx's behaviour, not this library's.
window.__htmxProcessed = [];
window.htmx = {
	process(root) {
		window.__htmxProcessed.push(root.id || root.tagName.toLowerCase());
	},
};
