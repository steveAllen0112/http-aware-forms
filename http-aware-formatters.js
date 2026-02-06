// HTTP-Aware Forms - Standard Formatters (optional)
// Include after http-aware.js to add these formatters

Object.assign(HTTPAwareForm.formatters, {
	decimal: (val, precision = 2) => Number(val).toFixed(Number(precision)),
	pad: (val, width, char = '0') => String(val).padStart(Number(width), char),
	rfc7231: (val) => new Date(val).toUTCString(),
	iso: (val) => new Date(val).toISOString(),
	upper: (val) => String(val).toUpperCase(),
	lower: (val) => String(val).toLowerCase(),
});
