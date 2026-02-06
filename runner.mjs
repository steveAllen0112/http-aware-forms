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
		const browser = await chromium.launch({ headless: true });
		const page = await browser.newPage();

		for (const tc of spec.test_cases) {
			console.log(`\nRunning: ${tc.id} - ${tc.description}`);

			// Capture the request
			let captured = {};
			const handleRequest = (request) => {
				if (request.url().includes('localhost:9999')) {
					captured.method = request.method();
					captured.url = request.url();
					captured.headers = request.headers();
				}
			};

			page.on('request', handleRequest);

			// Load test page (standalone, no HTMX)
			await page.goto('http://localhost:8000/index-standalone.html');
			await page.waitForLoadState('networkidle');

			// Set form values
			const fs = tc.form_state;

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

			// Submit
			captured = {};
			await page.click('button[type="submit"]');
			await page.waitForTimeout(1000);

			// Validate
			const expected = tc.expected_request;
			let passed = true;
			const errors = [];

			// Check headers
			if (expected.headers) {
				for (const [header, expectedVal] of Object.entries(expected.headers)) {
					const actualVal = captured.headers?.[header.toLowerCase()] || '';
					if (actualVal !== expectedVal.toLowerCase()) {
						errors.push(`Header ${header}: got '${actualVal}', expected '${expectedVal.toLowerCase()}'`);
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

			// Check query_must_contain
			if (expected.query_must_contain) {
				for (const mustHave of expected.query_must_contain) {
					if (!queryString.includes(mustHave)) {
						errors.push(`Query missing '${mustHave}' in: ${queryString}`);
						passed = false;
					}
				}
			}

			// Check query_must_not_contain
			if (expected.query_must_not_contain) {
				for (const mustNotHave of expected.query_must_not_contain) {
					if (queryString.includes(mustNotHave)) {
						errors.push(`Query contains forbidden '${mustNotHave}' in: ${queryString}`);
						passed = false;
					}
				}
			}

			results.push({
				id: tc.id,
				passed,
				errors,
				captured: {
					url: actualUrl,
					headers: captured.headers || {}
				}
			});

			const statusStr = passed ? '[OK] PASS' : '[X] FAIL';
			console.log(`  ${statusStr}`);
			if (!passed) {
				console.log(`    URL: ${actualUrl}`);
				console.log(`    Headers: Prefer=${captured.headers?.prefer || 'MISSING'}, Range=${captured.headers?.range || 'MISSING'}`);
			}
			for (const e of errors) {
				console.log(`    ${e}`);
			}

			page.removeListener('request', handleRequest);
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
