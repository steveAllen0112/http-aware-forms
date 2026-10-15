#!/usr/bin/env python3
"""
Request logger that validates incoming requests against expectations.
Logs PASS/FAIL for each request with detailed header inspection.
"""
from http.server import HTTPServer, BaseHTTPRequestHandler
from urllib.parse import urlparse, parse_qs
import html
import json
import re
import sys
import time

# Load expectations
EXPECTATIONS = {
	"header_format_spec": {
		"Prefer": r"^view=[a-z-]+$",
		"Range": r"^pages=\d+@\d+$"
	}
}

class RequestValidator(BaseHTTPRequestHandler):
	def validate_headers(self):
		errors = []

		# Check Prefer header
		prefer = self.headers.get('Prefer')
		if not prefer:
			errors.append("MISSING: Prefer header")
		elif not re.match(EXPECTATIONS["header_format_spec"]["Prefer"], prefer):
			errors.append(f"INVALID FORMAT: Prefer='{prefer}' (expected: view=<value>)")

		# Check Range header
		range_h = self.headers.get('Range')
		if not range_h:
			errors.append("MISSING: Range header")
		elif not re.match(EXPECTATIONS["header_format_spec"]["Range"], range_h):
			errors.append(f"INVALID FORMAT: Range='{range_h}' (expected: pages=N@M)")

		# Check path has no pagination params
		parsed = urlparse(self.path)
		if ';page=' in self.path or ';per=' in self.path or ';view=' in self.path:
			errors.append(f"LEAK: Matrix params in path: {self.path}")

		query = parse_qs(parsed.query)
		for param in ['page', 'per', 'per_page', 'view']:
			if param in query:
				errors.append(f"LEAK: Query param '{param}' in path: {self.path}")

		return errors

	def log_request_details(self):
		errors = self.validate_headers()
		status = "PASS" if not errors else "FAIL"

		print(f"\n{'='*70}")
		print(f"[{status}] {self.command} {self.path}")
		print(f"{'='*70}")
		print("HEADERS:")
		for name, value in sorted(self.headers.items()):
			marker = ""
			if name in ['Prefer', 'Range']:
				marker = " [OK]" if not any(name in e for e in errors) else " [X]"
			print(f"  {name}: {value}{marker}")

		if errors:
			print("\nVALIDATION ERRORS:")
			for e in errors:
				print(f"  X {e}")
		else:
			print("\n  [OK] All validations passed")

		print(f"{'='*70}\n")
		return status == "PASS"

	def send_cors_headers(self):
		self.send_header('Access-Control-Allow-Origin', '*')
		self.send_header('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS')
		self.send_header('Access-Control-Allow-Headers', '*')
		self.send_header('Access-Control-Expose-Headers', 'Content-Range, Link, HX-Push-Url, X-Retarget')

	def do_OPTIONS(self):
		self.send_response(200)
		self.send_cors_headers()
		self.end_headers()

	def do_GET(self):
		path = urlparse(self.path).path
		if path == '/push':
			return self.answer_push()
		if path == '/ok':
			return self.answer_ok()
		if path == '/oob':
			return self.answer_oob()
		passed = self.log_request_details()

		self.send_response(206 if passed else 400)
		self.send_cors_headers()
		self.send_header('Content-Type', 'text/html')
		self.send_header('Content-Range', 'pages 1-1/1@10')
		self.end_headers()

		if passed:
			response = f'''
			<div style="color: green; font-weight: bold;">
			[OK] REQUEST VALID<br>
			Path: {self.path}<br>
			Prefer: {self.headers.get('Prefer')}<br>
			Range: {self.headers.get('Range')}
			</div>
			'''
		else:
			response = f'''
			<div style="color: red; font-weight: bold;">
			[X] REQUEST INVALID - Check server console
			</div>
			'''
		self.wfile.write(response.encode())

	def answer_push(self):
		# /push?push=<address> is answered 200 with HX-Push-Url naming that
		# address, so a case can ask for a history write of an address it chose
		# (the page's own, or another). It carries no Prefer or Range to check.
		address = parse_qs(urlparse(self.path).query).get('push', [''])[0]
		print(f"\n[PUSH] GET {self.path}\n  HX-Push-Url: {address}\n")

		self.send_response(200)
		self.send_cors_headers()
		self.send_header('Content-Type', 'text/html')
		if address:
			self.send_header('HX-Push-Url', address)
		self.end_headers()
		self.wfile.write(f'<p>HX-Push-Url: {html.escape(address)}</p>'.encode())

	def answer_ok(self):
		# /ok is answered 200 whatever it carries, for a case that counts the
		# requests one click or one change sends. It has no Prefer or Range to check.
		print(f"\n[OK] GET {self.path}\n")

		self.send_response(200)
		self.send_cors_headers()
		self.send_header('Content-Type', 'text/html')
		self.end_headers()
		self.wfile.write(f'<p>GET {html.escape(self.path)}</p>'.encode())

	def answer_oob(self):
		# /oob is answered with one primary element and four others: one marked
		# out of band to replace its element, one marked to fill its element, one
		# marked with no element on the page to go to, and one unmarked whose id
		# the page carries. ?retarget=<selector> adds X-Retarget naming it.
		retarget = parse_qs(urlparse(self.path).query).get('retarget', [''])[0]
		print(f"\n[OOB] GET {self.path}\n  X-Retarget: {retarget or '(none)'}\n")

		self.send_response(200)
		self.send_cors_headers()
		self.send_header('Content-Type', 'text/html')
		if retarget:
			self.send_header('X-Retarget', retarget)
		self.end_headers()
		self.wfile.write('''<p class="fresh">primary, new</p>
<section id="oob-outer" class="replaced" data-swap-oob="true"><p class="fresh">outer, new</p></section>
<aside id="oob-inner" class="edition" data-swap-oob="innerHTML"><p class="fresh">inner, new</p></aside>
<section id="oob-missing" data-swap-oob="true"><p class="fresh">nowhere to go</p></section>
<section id="oob-unmarked"><p class="fresh">unmarked, new</p></section>'''.encode())

	def do_PATCH(self):
		# A PATCH is answered with the body it carried. The reply is 2xx, so the
		# form takes what it sent as accepted, unless the path asks for a refusal
		# (/refuse), which is answered 409 so a case can show nothing was taken.
		# /slow is answered half a second late, so a case can act while the
		# request is on its way.
		length = int(self.headers.get('Content-Length') or 0)
		body = self.rfile.read(length).decode('utf-8', 'replace')
		refused = urlparse(self.path).path == '/refuse'
		if urlparse(self.path).path == '/slow':
			time.sleep(0.5)
		print(f"\n[{'REFUSED' if refused else 'ACCEPTED'}] PATCH {self.path}\n  body: {body}\n")

		self.send_response(409 if refused else 200)
		self.send_cors_headers()
		self.send_header('Content-Type', 'text/plain' if refused else 'text/html')
		self.end_headers()
		if refused:
			self.wfile.write(b'refused')
		else:
			self.wfile.write(f'<p>PATCH {html.escape(self.path)}: {html.escape(body)}</p>'.encode())

if __name__ == '__main__':
	port = int(sys.argv[1]) if len(sys.argv) > 1 else 9999
	server = HTTPServer(('localhost', port), RequestValidator)
	print(f"""
+======================================================================+
|  PAGINATION REQUEST VALIDATOR                                        |
|  http://localhost:{port}                                               |
+----------------------------------------------------------------------+
|  Expected headers:                                                   |
|    Prefer: view=<list|cards|kanban|table-rows|...>                   |
|    Range: pages=<N>@<M>                                              |
|                                                                      |
|  Path must NOT contain: ;page= ;per= ;view= ?page= ?per= ?view=      |
+======================================================================+
""")
	server.serve_forever()
