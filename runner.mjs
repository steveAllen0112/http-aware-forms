#!/usr/bin/env node
/**
 * Automated test runner using Playwright.
 * Tests that http-aware forms correctly route fields to headers vs query params.
 *
 * Usage:
 *   node runner.mjs
 *   # Or with npx:
 *   npx playwright test runner.mjs
 */
import { chromium } from 'playwright';
import { spawn } from 'child_process';
import { readFile } from 'fs/promises';
import { URL } from 'url';

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

async function runTests() {
	const spec = JSON.parse(await readFile('expectations.json', 'utf-8'));

	// Start the validator server
	const server = spawn('python3', ['server.py', '9999'], {
		stdio: ['ignore', 'pipe', 'pipe']
	});
	await sleep(1000);

	// Start static file server for test page
	const httpServer = spawn('python3', ['-m', 'http.server', '8000'], {
		stdio: ['ignore', 'pipe', 'pipe']
	});
	await sleep(1000);

	const results = [];

	try {
		// Prefer Playwright's own browser; fall back to a system Chrome/Chromium so
		// a fresh clone can run the suite without `npx playwright install` first.
		let browser;
		try {
			browser = await chromium.launch({ headless: true });
		} catch {
			console.log('Bundled browser missing — falling back to system Chrome.');
			browser = await chromium.launch({ headless: true, channel: 'chrome' });
		}
		const shared = await browser.newPage();

		for (const tc of spec.test_cases) {
			console.log(`\nRunning: ${tc.id} - ${tc.description}`);

			// A case that counts history entries runs in a tab of its own. Chromium
			// caps a tab's history at 50 entries, and once the shared tab reaches
			// the cap a push drops the oldest entry and history.length stays put.
			const countsHistory = (tc.steps || [tc]).some(s => s.expected_request?.history_added !== undefined);
			const page = countsHistory ? await browser.newPage() : shared;

			// Capture the request
			let captured = {};
			// A form with no action submits to the page's own address, so a case
			// that tests one (capture_self) captures the page's host as well.
			const self = 'http://localhost:8000/index-standalone.html?';
			const handleRequest = (request) => {
				if (request.url().includes('localhost:9999') || (tc.capture_self && request.url().startsWith(self))) {
					captured.method = request.method();
					captured.url = request.url();
					captured.headers = request.headers();
					captured.body = request.postData() || '';
				}
			};

			page.on('request', handleRequest);

			// Load test page (standalone, no HTMX)
			// page_query loads the page at an address that already carries a query,
			// which is what a self-submitting form submits back to.
			await page.goto('http://localhost:8000/index-standalone.html' + (tc.page_query || ''));
			await page.waitForLoadState('networkidle');
			// A case that exercises an optional add-on (http-aware-htmx.js) loads it
			// onto the page first; the add-on registers its hooks as it loads.
			if (tc.interop) await page.addScriptTag({ url: `http://localhost:8000/${tc.interop}` });

			// `form` names the form a case submits (default: the demo form), and
			// every generic field is looked up inside it, so two forms may use the
			// same control name without a case reaching into the wrong one.
			const form = tc.form || 'demo';
			let passed = true;
			const errors = [];

			// A case is one submission, or `steps`: several made in turn on the one
			// loaded page, each with its own form_state, checks and expected_request
			// — for a case whose point is what an earlier submission left behind.
			const steps = tc.steps || [tc];
			for (const [index, step] of steps.entries()) {
				const at = steps.length > 1 ? `Step ${index + 1}: ` : '';

				// Set form values
				const fs = step.form_state || {};

				await page.fill('input[name="page"]', fs.page || '1');
				await page.selectOption('select[name="per"]', fs.per || '25');

				const view = fs.view || 'list';
				await page.click(`input[name="view"][value="${view}"]`);

				// Set wait preference (for append semantics test)
				if (fs.wait) {
					await page.selectOption('select[name="wait"]', fs.wait);
				} else {
					await page.selectOption('select[name="wait"]', '');
				}

				// Set replace semantics test fields
				await page.fill('input[name="first"]', fs.first || 'aaa');
				await page.fill('input[name="second"]', fs.second || 'bbb');

				// Set filter fields
				if (fs.status) {
					await page.selectOption('select[name="status"]', fs.status);
				}
				if (fs.q) {
					await page.fill('input[name="q"]', fs.q);
				}

				// Any field the block above does not know about: set it generically,
				// so a new test case can introduce new controls without editing the
				// runner. The known fields keep their explicit defaults above,
				// because existing cases depend on a missing key meaning "default".
				// A select takes a value or a list of them; an empty list clears it.
				const known = ['page', 'per', 'view', 'wait', 'first', 'second', 'status', 'q'];
				for (const [name, value] of Object.entries(fs)) {
					if (known.includes(name)) continue;
					const sel = `#${form} [name="${name}"]`;
					const tag = await page.$eval(sel, (el) => el.tagName).catch(() => null);
					if (tag === 'SELECT') await page.selectOption(sel, value);
					else if (tag) await page.fill(sel, value);
					else console.log(`  [warn] no control named ${name}`);
				}
				// Checkboxes and radios, by selector: { "<selector>": true | false }.
				for (const [sel, on] of Object.entries(step.checks || {})) {
					await page.setChecked(sel, on);
				}

				// Submit
				captured = {};
				const historyBefore = await page.evaluate(() => history.length);
				await page.click(`#${form} button[type="submit"]`);
				await page.waitForTimeout(1000);

				// Validate
				const expected = step.expected_request;

				// Check headers
				if (expected.headers) {
					for (const [header, expectedVal] of Object.entries(expected.headers)) {
						const actualVal = captured.headers?.[header.toLowerCase()] || '';
						if (actualVal !== expectedVal.toLowerCase()) {
							errors.push(`${at}Header ${header}: got '${actualVal}', expected '${expectedVal.toLowerCase()}'`);
							passed = false;
						}
					}
				}

				// Parse the captured URL
				const actualUrl = captured.url || '';
				let queryString = '';
				try {
					const parsed = new URL(actualUrl);
					queryString = parsed.search.slice(1); // Remove leading ?
				} catch (e) {
					// URL parsing failed
				}

				// Check dom_counts: { "<selector>": <count> } after the swap — for a case whose
				// point is where the response landed rather than what was requested.
				for (const [sel, want] of Object.entries(expected.dom_counts || {})) {
					const got = await page.locator(sel).count();
					if (got !== want) {
						errors.push(`${at}DOM ${sel}: ${got} element(s), expected ${want}`);
						passed = false;
					}
				}

				// Check what the submission wrote to the browser's history:
				// history_added is how many entries it added, location the page's
				// address afterwards, history_state the state the current entry holds
				// — which tells a replaced entry from one left alone.
				if (expected.history_added !== undefined) {
					const added = await page.evaluate(() => history.length) - historyBefore;
					if (added !== expected.history_added) {
						errors.push(`${at}History length changed by ${added}, expected ${expected.history_added}`);
						passed = false;
					}
				}
				if (expected.location !== undefined) {
					const href = await page.evaluate(() => location.href);
					if (href !== expected.location) {
						errors.push(`${at}Location is '${href}', expected '${expected.location}'`);
						passed = false;
					}
				}
				if (expected.history_state !== undefined) {
					const state = await page.evaluate(() => JSON.stringify(history.state));
					if (state !== JSON.stringify(expected.history_state)) {
						errors.push(`${at}History state is ${state}, expected ${JSON.stringify(expected.history_state)}`);
						passed = false;
					}
				}

				// Check query_exact: the whole query, byte for byte and in order.
				if (expected.query_exact !== undefined && queryString !== expected.query_exact) {
					errors.push(`${at}Query is '${queryString}', expected exactly '${expected.query_exact}'`);
					passed = false;
				}

				// Check query_must_contain
				if (expected.query_must_contain) {
					for (const mustHave of expected.query_must_contain) {
						if (!queryString.includes(mustHave)) {
							errors.push(`${at}Query missing '${mustHave}' in: ${queryString}`);
							passed = false;
						}
					}
				}

				// Check query_must_not_contain
				if (expected.query_must_not_contain) {
					for (const mustNotHave of expected.query_must_not_contain) {
						if (queryString.includes(mustNotHave)) {
							errors.push(`${at}Query contains forbidden '${mustNotHave}' in: ${queryString}`);
							passed = false;
						}
					}
				}

				// Check the request body, as sent: body_exact is the whole of it, byte
				// for byte and in order; the other two look for a pair within it.
				const body = captured.body || '';
				if (expected.body_exact !== undefined && body !== expected.body_exact) {
					errors.push(`${at}Body is '${body}', expected exactly '${expected.body_exact}'`);
					passed = false;
				}
				for (const mustHave of expected.body_must_contain || []) {
					if (!body.includes(mustHave)) {
						errors.push(`${at}Body missing '${mustHave}' in: ${body}`);
						passed = false;
					}
				}
				for (const mustNotHave of expected.body_must_not_contain || []) {
					if (body.includes(mustNotHave)) {
						errors.push(`${at}Body contains forbidden '${mustNotHave}' in: ${body}`);
						passed = false;
					}
				}
			}

			results.push({
				id: tc.id,
				passed,
				errors,
				captured: {
					url: captured.url || '',
					headers: captured.headers || {},
					body: captured.body || ''
				}
			});

			const statusStr = passed ? '[OK] PASS' : '[X] FAIL';
			console.log(`  ${statusStr}`);
			if (!passed) {
				console.log(`    URL: ${captured.url || ''}`);
				console.log(`    Headers: Prefer=${captured.headers?.prefer || 'MISSING'}, Range=${captured.headers?.range || 'MISSING'}`);
				console.log(`    Body: ${captured.body || ''}`);
			}
			for (const e of errors) {
				console.log(`    ${e}`);
			}

			page.removeListener('request', handleRequest);
			if (page !== shared) await page.close();
		}

		await browser.close();

	} finally {
		server.kill();
		httpServer.kill();
	}

	// Summary
	const passedCount = results.filter(r => r.passed).length;
	console.log(`\n${'='.repeat(60)}`);
	console.log(`RESULTS: ${passedCount}/${results.length} tests passed`);
	console.log(`${'='.repeat(60)}`);

	// Print detailed results for failures
	const failures = results.filter(r => !r.passed);
	if (failures.length > 0) {
		console.log('\nFailed tests:');
		for (const f of failures) {
			console.log(`\n  ${f.id}:`);
			console.log(`    URL: ${f.captured.url}`);
			console.log(`    Headers:`, f.captured.headers);
			console.log(`    Body: ${f.captured.body}`);
			for (const e of f.errors) {
				console.log(`    - ${e}`);
			}
		}
	}

	return results.every(r => r.passed);
}

runTests().then(success => {
	process.exit(success ? 0 : 1);
}).catch(err => {
	console.error('Test runner error:', err);
	process.exit(1);
});
