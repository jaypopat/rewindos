#!/usr/bin/env python3
"""Verify production analytics with synthetic data in native WebKitGTK."""
import argparse
import base64
import gzip
import json
from pathlib import Path
import subprocess
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlsplit
import gi

gi.require_version('Gtk', '3.0')
gi.require_version('WebKit2', '4.1')
from gi.repository import GLib, Gtk, WebKit2

ROOT = Path(__file__).resolve().parents[2]
INSTALL_ID = '6f1c2a54-93b5-4d0e-9a51-2b7c8e1f0d3a'
parser = argparse.ArgumentParser()
parser.add_argument('--output', type=Path, default=ROOT / '.audit/analytics-native')
args = parser.parse_args()
args.output.mkdir(parents=True, exist_ok=True)
bundle = args.output / 'fixture.js'
subprocess.run(['bun', 'build', str(ROOT / 'scripts/analytics/fixture.ts'), '--target', 'browser', '--outfile', str(bundle)], check=True, cwd=ROOT)
requests, failures = [], []
phase = 'initial'
done = threading.Event()


def decode(value):
    if isinstance(value, list):
        return [decode(item) for item in value]
    if isinstance(value, dict):
        return {key: decode(item) for key, item in value.items()}
    if isinstance(value, str) and value.startswith('\x1f\x8b'):
        return decode(json.loads(gzip.decompress(value.encode('latin1'))))
    return value


def decode_body(body, headers):
    if headers.get('Content-Encoding') == 'gzip' or body.startswith(b'\x1f\x8b'):
        body = gzip.decompress(body)
    try:
        return decode(json.loads(body))
    except (ValueError, UnicodeDecodeError):
        raw = base64.b64decode(parse_qs(body.decode())['data'][0])
        if raw.startswith(b'\x1f\x8b'):
            raw = gzip.decompress(raw)
        return decode(json.loads(raw))


class Receiver(BaseHTTPRequestHandler):
    def log_message(self, *_args):
        pass

    def respond(self, body=b'{}', status=200):
        self.send_response(status)
        if status == 503:
            self.send_header('Retry-After', '60')
        for name, value in [('Content-Type', 'application/json'), ('Content-Length', str(len(body))), ('Access-Control-Allow-Origin', '*'), ('Access-Control-Allow-Headers', '*'), ('Access-Control-Expose-Headers', 'Retry-After'), ('Cache-Control', 'no-store')]:
            self.send_header(name, value)
        self.end_headers()
        self.wfile.write(body)

    def do_OPTIONS(self):
        self.respond()

    def do_GET(self):
        requests.append({'phase': phase, 'method': 'GET', 'path': self.path})
        self.respond(json.dumps({
            'hasFeatureFlags': False, 'logs': {'captureConsoleLogs': True}, 'autocapture_opt_out': False, 'supportedCompression': ['gzip', 'gzip-js'], 'capturePerformance': True,
            'sessionRecording': {'endpoint': '/s/', 'sampleRate': 1, 'minimumDurationMilliseconds': 0, 'consoleLogRecordingEnabled': True, 'recordCanvas': True,
                'networkPayloadCapture': {'recordHeaders': True, 'recordBody': True},
                'masking': {'maskAllInputs': False, 'maskTextSelector': '', 'blockSelector': '', 'maskAllElementAttributes': False}}
        }).encode())

    def do_POST(self):
        body = self.rfile.read(int(self.headers.get('Content-Length', '0')))
        try:
            status = 503 if self.path == '/e/' and not any(r.get('response_status') == 503 for r in requests) else 200
            requests.append({'phase': phase, 'method': 'POST', 'path': self.path, 'payload': decode_body(body, self.headers), 'response_status': status})
        except Exception as error:
            failures.append(f'decode {type(error).__name__}: {error}')
            status = 200
        self.respond(status=status)


ingestion = ThreadingHTTPServer(('127.0.0.1', 0), Receiver)
ingestion_url = f'http://127.0.0.1:{ingestion.server_port}'


class Fixture(BaseHTTPRequestHandler):
    def log_message(self, *_args):
        pass

    def do_GET(self):
        global phase
        path = urlsplit(self.path).path
        content_type = 'text/html'
        if path == '/fixture.js':
            body, content_type = bundle.read_bytes(), 'application/javascript'
        elif path == '/bootstrap':
            content_type = 'application/json'
            body = json.dumps({'enabled': True, 'project': {
                'endpoint': {'host': ingestion_url, 'api_key': 'phc_synthetic_only'}, 'distinct_id': INSTALL_ID,
                'common': {'app_version': 'synthetic', 'desktop': 'other', 'distro': 'synthetic', 'source': 'ui', '$geoip_disable': True}
            }}).encode()
        elif path.startswith('/phase/'):
            phase = path.split('/')[-1]
            if phase == 'done':
                done.set()
                GLib.idle_add(Gtk.main_quit)
            body = b'{}'
        else:
            body = b'''<!doctype html><html><head><title>CANARY_INITIAL_TITLE</title></head><body>
<div id="root"><style id="synthetic-style">.initial::before { content: "CANARY_INITIAL_STYLESHEET"; }</style><button id="unapproved" data-private="CANARY_UNAPPROVED_CONTROL">CANARY_UNAPPROVED_TEXT</button><nav><button data-analytics-control="nav-search" data-ph-capture-attribute-control="nav-search" title="CANARY_CONTROL_TITLE" data-private="CANARY_CONTROL_ATTRIBUTE"><span data-replay-label="nav-search">Search</span></button></nav>
<div id="unsafe" title="CANARY_INITIAL_TITLE_ATTRIBUTE" data-private="CANARY_INITIAL_ATTRIBUTE" style="background-image:url('/CANARY_INITIAL_CSS')">CANARY_INITIAL_TEXT</div>
<input value="CANARY_INITIAL_INPUT" placeholder="CANARY_INITIAL_PLACEHOLDER" name="CANARY_INPUT_NAME" title="CANARY_INPUT_TITLE"><input type="hidden" value="CANARY_HIDDEN"><input type="file" name="CANARY_FILE_PATH">
<div data-analytics-sensitive><p>CANARY_SCREENSHOT_OCR_APP_WINDOW_SEARCH_PROMPT_CHAT_JOURNAL_MEETING_PATH_API_KEY</p><img src="/CANARY_SCREENSHOT_ASSET"><canvas></canvas></div>
<img src="/CANARY_IMAGE"><canvas title="CANARY_CANVAS_TITLE"></canvas><video src="/CANARY_MEDIA"></video><iframe src="/CANARY_IFRAME"></iframe>
</div><div title="CANARY_PORTAL_INITIAL_ATTRIBUTE">CANARY_PORTAL_INITIAL_TEXT</div><script src="/fixture.js"></script></body></html>'''
        self.send_response(200)
        for name, value in [('Content-Type', content_type), ('Content-Length', str(len(body))), ('Content-Security-Policy', f"default-src 'none'; script-src 'self'; connect-src 'self' {ingestion_url}; style-src 'unsafe-inline'; img-src 'self' data:")]:
            self.send_header(name, value)
        self.end_headers()
        self.wfile.write(body)

    def do_POST(self):
        body = self.rfile.read(int(self.headers.get('Content-Length', '0')))
        if self.path == '/failure':
            failures.append(body.decode())
            GLib.idle_add(Gtk.main_quit)
        self.send_response(200)
        self.send_header('Content-Length', '2')
        self.end_headers()
        self.wfile.write(b'{}')


origin = ThreadingHTTPServer(('127.0.0.1', 0), Fixture)
for server in [ingestion, origin]:
    threading.Thread(target=server.serve_forever, daemon=True).start()
window = Gtk.OffscreenWindow()
window.set_default_size(900, 650)
view = WebKit2.WebView.new_with_context(WebKit2.WebContext.new_ephemeral())
window.add(view)
window.show_all()
view.load_uri(f'http://127.0.0.1:{origin.server_port}/?secret=CANARY_INITIAL_URL#CANARY_INITIAL_HASH')
GLib.timeout_add_seconds(65, lambda: (failures.append('native fixture timed out'), Gtk.main_quit(), False)[-1])
Gtk.main()
window.destroy()
for server in [ingestion, origin]:
    server.shutdown()
(args.output / 'payloads.json').write_text(json.dumps(requests, indent=2))
payloads = [request['payload'] for request in requests if 'payload' in request]
events = [event for payload in payloads for event in (payload if isinstance(payload, list) else payload.get('batch', [payload])) if isinstance(event, dict) and 'event' in event]
snapshots = [snapshot for event in events if event.get('event') == '$snapshot' for snapshot in event['properties']['$snapshot_data']]
checks = {
    'fixture_completed': done.is_set(),
    'decoded_every_payload': not failures,
    'no_secret_canaries_in_any_request': 'CANARY_' not in json.dumps(requests),
    'replay_hard_disabled_despite_remote_enable': not snapshots and not any(e.get('event') == '$snapshot' for e in events),
    'safe_control_autocapture': any(e.get('event') == '$autocapture' and e['properties'].get('control') == 'nav-search' for e in events),
    'navigation_and_native_actions': {'app_opened', 'view_opened', 'ask_sent', 'search_performed'}.issubset({e.get('event') for e in events}),
    'shared_install_identity': bool(events) and all(e['properties'].get('distinct_id') == INSTALL_ID for e in events),
    'no_alias_or_identify': not any(e.get('event') in ['$identify', '$create_alias'] for e in events),
    'sdk_enrichment_preserved': any(all(k in e['properties'] for k in ['$session_id', '$window_id', '$browser', '$os', '$viewport_width', '$screen_height', '$lib_version']) for e in events if e.get('event') != '$snapshot'),
    'off_pending_on_external_off_silent': not any(r['phase'] in ['off', 'pending-on', 'external-off', 'done'] for r in requests),
    'pending_retry_exercised': any(r.get('response_status') == 503 for r in requests),
    'discarded_retry_not_resent': len({e['uuid'] for e in events}) == len(events),
    'queued_events_discarded': not any(e.get('event') == 'search_performed' and e['properties'].get('mode') == 'keyword' for e in events),
    'opted_out_native_events_discarded': not any(e.get('event') == 'ask_sent' and e['properties'].get('provider') == 'custom' for e in events),
    'resumed_after_persisted_on': any(r['phase'] == 'on' and 'payload' in r for r in requests),
    'token_preserved': bool(events) and all(e['properties'].get('token') == 'phc_synthetic_only' for e in events),
    'no_external_script_requests': all((r['method'] == 'GET' and r['path'] == '/array/phc_synthetic_only/config') or (r['method'] == 'POST' and r['path'] in ['/e/', '/s/']) for r in requests),
    'only_approved_controls': all(e['properties'].get('control') == 'nav-search' for e in events if e.get('event') == '$autocapture'),
}
report = {'runtime': 'WebKitGTK ' + '.'.join(str(fn()) for fn in [WebKit2.get_major_version, WebKit2.get_minor_version, WebKit2.get_micro_version]), 'sdk': 'posthog-js 1.438.23', 'checks': checks, 'failures': failures, 'requests': len(requests), 'events': len(events), 'snapshots': len(snapshots), 'replay_policy': 'hard-disabled after native stylesheet canary leak', 'playback_verified': False}
(args.output / 'report.json').write_text(json.dumps(report, indent=2))
print(json.dumps(report, indent=2))
raise SystemExit(0 if all(checks.values()) else 1)
