# HTTP-Aware Forms

HTML forms that speak the whole of HTTP.

A native `<form>` knows two methods and no headers, submits its entire contents every time, and can only replace the whole page with the reply. This library extends `<form>` so that PUT, PATCH, DELETE and HEAD work, request headers are declared in markup, PATCH bodies carry only what the user changed, fields can be namespaced by the fieldset that contains them, and the response lands where you say instead of navigating.

All of it is declared in attributes. There is no configuration, no build step and no framework — the demo page in this repository has no JavaScript on it beyond the one `<script>` that loads the library.

**New in 2.0:** [namespaced fieldsets](#namespaced-fieldsets), [dirty-only PATCH bodies](#dirty-only-patch-bodies), [targeting the response](#targeting-the-response) with seven swap modes and out-of-band updates, and [`autosubmit`](#autosubmit-and-debounce). Everything from 1.0 still works unchanged.

## Installation

One file, no build step:

```html
<script src="https://raw.githubusercontent.com/steveAllen0112/http-aware-forms/main/http-aware.js"></script>
```

Optional, and each loaded *after* it: `http-aware-formatters.js` for named value
formatters in header templates, and `http-aware-htmx.js` if the page also runs
htmx.

There is deliberately no minified build. The source is one readable file, and
minifying it returned about 28% before gzip — which every server already does on
the wire, and does better. Shipping a `dist/` meant maintaining a second artifact
that could fall out of step with the source without anyone noticing, and in 1.0
it did exactly that.

## Quick Example

```html
<form is="http-aware" action="/api/items" method="delete">
  <label>Item ID: <input type="number" name="id" value="123"></label>
  <button type="submit">Delete Item</button>
</form>
```

That's a DELETE request. Native forms can't do this.

## Declaring Headers

Use `<fieldset is="request-header">` to declare HTTP headers with interpolated values:

```html
<form is="http-aware" action="/companies" method="get">
  <fieldset is="request-header" header="Range" value="pages={page}@{per}">
    <input name="page" type="number" value="1">
    <select name="per">
      <option>10</option>
      <option selected>25</option>
      <option>50</option>
    </select>
  </fieldset>
  <button type="submit">Load</button>
</form>
```

Submitting sends: `Range: pages=1@25`

Inputs inside the fieldset go to that header. Inputs outside go to the query string (GET/HEAD/DELETE) or request body (POST/PUT/PATCH).

## Linking Inputs with `for=`

Inputs outside a fieldset can link to it using `for=`:

```html
<form is="http-aware" action="/items" method="get">
  <fieldset is="request-header" id="view-pref" header="Prefer" value="view={view}">
    <legend>View</legend>
  </fieldset>

  <label><input type="radio" name="view" value="list" for="view-pref" checked> List</label>
  <label><input type="radio" name="view" value="cards" for="view-pref"> Cards</label>

  <button type="submit">Load</button>
</form>
```

Submitting sends: `Prefer: view=list`

## Value Formatting

Values are interpolated as strings by default. Use format specifiers for control:

```html
<fieldset is="request-header" header="X-Quality" value="{quality,decimal(2)}">
  <input name="quality" type="number" step="0.01" value="0.95">
</fieldset>
<!-- Sends: X-Quality: 0.95 -->
```

Formatters are pluggable via `HTTPAwareForm.formatters`. The core library ships with none - add what you need:

```javascript
HTTPAwareForm.formatters.myFormat = (value, arg1, arg2) => /* transformed value */;
```

Include `http-aware-formatters.js` for a starter set:

- `decimal(n)` - Fixed decimal places
- `pad(width, char)` - Pad string (default: zeros)
- `upper` / `lower` - Case conversion
- `iso` - ISO 8601 datetime
- `rfc7231` - HTTP-date format

As proof-of-concepts, these are intentionally minimal. Roll your own for anything beyond the basics.

## Multiple Headers (RFC 9110)

Headers like `Prefer`, `Accept`, and `Cache-Control` are comma-joined per RFC 9110:

```html
<fieldset is="request-header" header="Prefer" value="view={view}">...</fieldset>
<fieldset is="request-header" header="Prefer" value="wait={timeout}">...</fieldset>
<!-- Sends: Prefer: view=list, wait=30 -->
```

Other headers use last-value-wins (replace semantics).

For structured headers with parameters, use template interpolation:

```html
<fieldset is="request-header" header="Content-Disposition" value="attachment; filename={filename}">
  <input name="filename" value="report.pdf">
</fieldset>
<!-- Sends: Content-Disposition: attachment; filename=report.pdf -->
```

## Composing a Value from Several Controls

HTML cannot build one form value out of several controls — an operator and its operand, a bound and its comparison. Every control submits its own pair. `<fieldset is="query-param">` states the pair as a template, with the same `{name}` / `{name,format}` placeholders a `request-header` uses:

```html
<fieldset is="query-param" name="name" value="{op}.{q}">
	<label><input type="radio" name="op" value="contains" checked> Contains</label>
	<label><input type="radio" name="op" value="eq"> Exactly</label>
	<input type="search" name="q">
</fieldset>
<!-- Sends: name=contains.acme — and no op= or q= -->

<fieldset is="query-param" name="amount" value="gte.{lo}"><input type="number" name="lo"></fieldset>
<fieldset is="query-param" name="amount" value="lte.{hi}"><input type="number" name="hi"></fieldset>
<!-- Sends: amount=gte.10&amount=lte.99, or only the bound that was filled in -->
```

- The controls inside are the template's **variables**: they submit nothing of their own.
- The pair is sent only when **every placeholder has a value**. An empty box withdraws the condition instead of sending `name=contains.`, and a disabled fieldset sends nothing.
- Several fieldsets may share a name; each is its own pair.
- The pair goes wherever the form's data goes: the query for GET, HEAD and DELETE, the body otherwise. Under PATCH it counts as dirty when any of its variables is.
- Inside a `name-space` fieldset its name is namespaced like a control's (`lease[term]`).
- In the [action-query merge](#an-actions-own-query) the fieldset owns the key it names, and its variables own nothing.

## HTTP Methods

| Method | Form Data Goes To |
|--------|------------------|
| GET | Query string |
| HEAD | Query string |
| DELETE | Query string |
| POST | Request body |
| PUT | Request body |
| PATCH | Request body |

Without a `target`, every method navigates to the response, just as a native form does. With one, the reply is swapped into the page instead — see [Targeting the Response](#targeting-the-response).

### An action's own query

A native GET form throws away any query its `action` already carries and writes the form data in its place. HTTP-Aware Forms does that only when the action is empty or absent — the platform's own case, where the form submits to the page's current address and that address's query is the previous submission's.

An **explicit** action is merged into instead. For GET, HEAD and DELETE:

1. every pair of the action's query whose key names a control of the form is dropped — a control owns its key whether or not it submits anything, so an unchecked box, an empty multi-select or a disabled field still withdraws the action's copy;
2. every other pair is kept exactly as written, in its order;
3. the form's own pairs follow.

```html
<!-- The server wrote the found set into the action; the form states only `status`. -->
<form is="http-aware" method="get" action="/orders?region=west&status=open" target="#results">
	<select name="status"><option>open</option><option>closed</option></select>
	<button>Apply</button>
</form>
<!-- choosing "closed" sends /orders?region=west&status=closed -->
```

A namespaced control owns its wire name (`lease[term]`), and a control inside a `request-header` fieldset owns its own name, so a key the form states as a header is not also sent from the action. See `docs/decisions/ADR-2026.09.23.explicit-action-query-merges.md`.

## Namespaced Fieldsets

A `fieldset` marked `is="name-space"` prefixes the fields it contains:

```html
<fieldset is="name-space" name="lease">
  <input name="rate" value="0.041">
  <input name="term_months" value="60">
</fieldset>
<!-- Sends: lease[rate]=0.041&lease[term_months]=60 -->
```

Nesting composes outward-in, so a `name-space` inside a `name-space` gives `outer[inner][field]`.

**Why this exists.** The DOM already models the grouping — `fieldset` is a listed element, and `HTMLFieldSetElement` has its own `.elements` collection, so two controls named `cost` in different fieldsets are distinguishable there. Submission throws that away and emits `cost=1&cost=2`. This closes the gap, opt-in.

Two things are deliberate. **An unmarked fieldset is untouched**, named or not — `name` on a fieldset is inert natively and applications already use it for sectioning, so a rule that namespaced every named fieldset would silently rename fields in forms written before the feature existed. And **the submitter keeps its own name**, because a submit button's name is the action being taken rather than a field of the group it happens to sit in.

The marker is hyphenated because it must be: a custom element name is required to contain a hyphen, for customized built-ins exactly as for autonomous ones, so `is="namespace"` cannot be registered at all.

## Dirty-Only PATCH Bodies

RFC 5789 says a PATCH body describes a delta, not the whole resource. Set `method="patch"` and that is what gets sent — every control whose value still matches its server-rendered default is dropped:

```html
<form is="http-aware" method="patch" action="/companies/42">
  <input name="name"  value="Acme">      <!-- untouched: not sent -->
  <input name="phone" value="555-0100">  <!-- edited:    sent -->
  <button type="submit" name="intent" value="save">Save</button>
</form>
```

The browser tracks the default natively through `defaultValue`, `defaultChecked` and `defaultSelected`, so there is no shadow copy to keep in step: after a successful PATCH the swapped-in markup carries new defaults and dirtiness resets by itself.

The submitter's own name and value are always sent, dirty or not — it states the intent.

## Targeting the Response

`target="<selector>@<swap>"` puts the reply somewhere instead of navigating:

```html
<form is="http-aware" method="get" action="/search" target="#results">
<form is="http-aware" method="patch" action="/row/7" target="#row-7@outerHTML">
<form is="http-aware" method="post" action="/log" target="#feed@afterbegin">
```

| Swap | Effect |
|------|--------|
| `innerHTML` | Replace the target's contents (default) |
| `outerHTML` | Replace the target itself |
| `morph` | Reconcile in place, preserving focus, selection, scroll and in-flight edits |
| `beforeend` / `afterbegin` | Append or prepend |
| `delete` | Remove the target |
| `none` | Do nothing with the body |

**A new edition of the target.** When the response is a single element carrying the target's own id, it is a new edition of the target, and `innerHTML` puts that element's inner HTML in — never the element itself, which would nest the target inside itself with its id twice over. This is what a panel's route returns when it renders the whole panel so it can be addressed on its own:

```html
<section id="panel">…old rows…</section>
<!-- target="#panel@innerHTML", and the response is: -->
<aside id="panel">…new rows…</aside>
<!-- becomes: -->
<section id="panel">…new rows…</section>
```

The match is on id only; any other response goes in as it is. To place an element inside the target, use an insertion style (`beforeend`, `afterbegin`).

`morph` is worth reaching for whenever the response contains the form that sent it: an `outerHTML` swap of a live panel destroys focus and any edit the user has begun, and a morph does not.

Elements in the response carrying `hx-swap-oob` or `data-swap` are applied to their own targets by id, so one response can update several places at once.

**Errors are not swapped.** A response that is not `ok` and is not HTML is surfaced as an `http-error` event and a toast rather than written into the target — swapping a JSON error body as `outerHTML` deletes the very panel it was reporting about.

## autosubmit and debounce

`autosubmit` names the events that submit the form, and `debounce` sets a delay in milliseconds:

```html
<!-- Commit-point saves: fires on blur or Enter, not on every keystroke -->
<form is="http-aware" method="patch" action="/prefs" autosubmit="change">

<!-- Live search, one request 300ms after typing stops -->
<form is="http-aware" method="get" action="/search" target="#results"
      autosubmit="input" debounce="300">
```

A button may override the delay for its own submission with `formdebounce`.

## Button Overrides (form* Attributes)

Submit buttons can override form attributes, just like native forms:

```html
<form is="http-aware" action="/items" method="get">
  <input type="number" name="id" value="42">
  <button type="submit">View</button>
  <button type="submit" formmethod="delete" formaction="/items/42">Delete</button>
  <button type="submit" formtarget="_blank">View in New Tab</button>
  <button type="submit" formnovalidate>Submit Without Validation</button>
</form>
```

| Attribute | Effect |
|-----------|--------|
| `formaction` | Override form's `action` URL |
| `formmethod` | Override form's `method` |
| `formenctype` | Override form's `enctype` (multipart, urlencoded, text/plain) |
| `formnovalidate` | Skip validation for this button |
| `formtarget` | Where to display response (`_self`, `_blank`, etc.) |

## Events and Manual Handling

The form dispatches `http-aware-submitted` when a request goes out, and `http-error` when a response comes back that is not `ok` and not HTML. Both bubble.

It also fires a standard `submit` event, so a request can still be taken over entirely — though as of 2.0 this is rarely needed, since the library issues the request and places the response itself:

```javascript
document.querySelector('form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const request = e.target.preparedRequest;  // Full Request object with headers
  const response = await fetch(request);
  // Handle response...
});
```

## Using it alongside htmx

The core knows nothing about any other library. If a page runs htmx too — usually because one is being migrated to the other — load the optional interop file after it:

```html
<script src="http-aware.js"></script>
<script src="http-aware-htmx.js"></script>
```

It teaches http-aware to recognise `hx-swap-oob` as an out-of-band marker, to honour `HX-Retarget`, `HX-Reswap` and `HX-Push-Url`, to send `HX-Request: true` on partial requests, and to run `htmx.process` over freshly-swapped markup so `hx-*` inside it goes live.

## Extending it

Four statics are the whole extension surface, and the interop file above is the worked example:

| Static | Purpose |
|--------|---------|
| `formatters` | Named value formatters for header templates |
| `requestHooks` | `(headers, form) => void`, called before each request goes out |
| `oobAttributes` | Attributes marking an element in a response as out-of-band |
| `retargetHeaders` / `reswapHeaders` | Response headers by which a server may redirect a swap |

Anything that must run over swapped-in markup listens for `http-aware:swapped`, whose detail carries `{ target, swapRoot, oobTargets, response }`.

## Browser Support

Works in all modern browsers that support [customized built-in elements](https://developer.mozilla.org/en-US/docs/Web/API/Web_components/Using_custom_elements#types_of_custom_element).

**Safari note:** Safari doesn't support `is="..."` for customized built-ins. Use the [Custom Elements Polyfill](https://github.com/nicknisi/custom-elements-polyfill) or wait for Safari to catch up.

## License

[MIT](https://opensource.org/licenses/MIT) - [Avance Enterprise Solutions, Inc.](https://avnc.net)
