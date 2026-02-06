# HTTP-Aware Forms

Expand HTML forms' HTTP methods and header declarations.

Native HTML forms only support GET and POST, with no access to HTTP headers. This library extends `<form>` to support PUT, PATCH, DELETE, HEAD, and lets you declare headers directly in markup.

## Installation

```html
<script src="https://raw.githubusercontent.com/avnc/http-aware-forms/v1.0.0/http-aware.js"></script>
```

Or download `http-aware.js` and include it locally.

## Quick Example

```html
<form is="http-aware" action="/api/items" method="delete">
  <label>Item ID: <input type="number" name="id" value="123"></label>
  <button type="submit">Delete Item</button>
</form>
```

That's a DELETE request. Native forms can't do this.

## Declaring Headers

Use `<request-header>` to declare HTTP headers with interpolated values:

```html
<form is="http-aware" action="/companies" method="get">
  <request-header name="Range" value="pages={page}@{per}">
    <input name="page" type="number" value="1">
    <select name="per">
      <option>10</option>
      <option selected>25</option>
      <option>50</option>
    </select>
  </request-header>
  <button type="submit">Load</button>
</form>
```

Submitting sends: `Range: pages=1@25`

Inputs inside `<request-header>` go to that header. Inputs outside go to the query string (GET/HEAD/DELETE) or request body (POST/PUT/PATCH).

## Linking Inputs with `for=`

Inputs outside `<request-header>` can link to it using `for=`:

```html
<form is="http-aware" action="/items" method="get">
  <request-header id="view-pref" name="Prefer" value="view={view}"></request-header>

  <label><input type="radio" name="view" value="list" for="view-pref" checked> List</label>
  <label><input type="radio" name="view" value="cards" for="view-pref"> Cards</label>

  <button type="submit">Load</button>
</form>
```

Submitting sends: `Prefer: view=list`

## Value Formatting

Values are interpolated as strings by default. Use format specifiers for control:

```html
<request-header name="X-Quality" value="{quality,decimal(2)}">
  <input name="quality" type="number" step="0.01" value="0.95">
</request-header>
<!-- Sends: X-Quality: 0.95 -->
```

Available formatters:
- `decimal(n)` - Fixed decimal places
- `pad(width, char)` - Pad string (default: zeros)
- `upper` / `lower` - Case conversion
- `iso` - ISO 8601 datetime
- `rfc7231` - HTTP-date format

## Multiple Headers (RFC 9110)

Headers like `Prefer`, `Accept`, and `Cache-Control` are comma-joined per RFC 9110:

```html
<request-header name="Prefer" value="view={view}"></request-header>
<request-header name="Prefer" value="wait={timeout}"></request-header>
<!-- Sends: Prefer: view=list, wait=30 -->
```

Other headers use last-value-wins (replace semantics).

## Structured Header Parameters

Target header parameters with bracket syntax:

```html
<request-header name="Content-Disposition" value="attachment"></request-header>
<request-header name="Content-Disposition[filename]" value="{filename}"></request-header>
<!-- Sends: Content-Disposition: attachment; filename="report.pdf" -->
```

## HTTP Methods

| Method | Form Data Goes To |
|--------|------------------|
| GET | Query string |
| HEAD | Query string |
| DELETE | Query string |
| POST | Request body |
| PUT | Request body |
| PATCH | Request body |

All methods navigate to the response, just like native forms.

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

## Intercepting Submissions

The form fires a standard `submit` event. Intercept it to handle the request yourself:

```javascript
document.querySelector('form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const request = e.target.preparedRequest;  // Full Request object with headers
  const response = await fetch(request);
  // Handle response...
});
```

## Browser Support

Works in all modern browsers that support [customized built-in elements](https://developer.mozilla.org/en-US/docs/Web/API/Web_components/Using_custom_elements#types_of_custom_element).

**Safari note:** Safari doesn't support `is="..."` for customized built-ins. Use the [Custom Elements Polyfill](https://github.com/nicknisi/custom-elements-polyfill) or wait for Safari to catch up.

## Important

Custom elements require explicit closing tags:

```html
<!-- Wrong -->
<request-header name="X-Foo" value="{bar}"/>

<!-- Right -->
<request-header name="X-Foo" value="{bar}"></request-header>
```

## License

MIT - Avance Enterprise Solutions, Inc.
