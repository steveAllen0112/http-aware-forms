#!/usr/bin/env python3
"""
Request logger that validates incoming requests against expectations.
Logs PASS/FAIL for each request with detailed header inspection.
"""
from http.server import HTTPServer, BaseHTTPRequestHandler
from urllib.parse import urlparse, parse_qs
import json
import re
import sys

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
		self.send_header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS')
		self.send_header('Access-Control-Allow-Headers', '*')
		self.send_header('Access-Control-Expose-Headers', 'Content-Range, Link')

	def do_OPTIONS(self):
		self.send_response(200)
		self.send_cors_headers()
		self.end_headers()

	def do_GET(self):
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
