#!/usr/bin/env bash
# Runs the ledger on this machine, the way it runs when published.
#
# The app has to be served over HTTP: opened as a file:// page the service worker will not register, the scripts cannot
# read one another and Firebase Auth refuses the origin outright. So this puts a small static server in front of the
# repository and prints the address to open.
#
#   ./run.sh                 serve on http://127.0.0.1:8000 and wait (Ctrl+C stops it)
#   ./run.sh --open          the same, and open a browser on it
#   ./run.sh --port 9000     another port (or the next free one, if that is taken too)
#   ./run.sh --host 0.0.0.0  reachable from a phone on the same network, for testing by hand
#   ./run.sh --sw            serve the real service worker instead of the development one
#   ./run.sh --background    leave it running and return to the prompt
#   ./run.sh --stop          stop one left running in the background
#
# Data still comes from the live Firebase project (see firebase-config.js), so this needs a connection and a sign-in;
# it is the published app, served from the working tree, not a copy of it with made-up figures.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PIDFILE="${TMPDIR:-/tmp}/kajanauday-run-$(id -u).pid"

HOST=127.0.0.1
PORT=8000
OPEN=0
BACKGROUND=0
STOP=0
REAL_SW=0

while [ $# -gt 0 ]; do
  case "$1" in
    --port|-p) PORT="${2:?--port needs a number}"; shift 2 ;;
    --host|-H) HOST="${2:?--host needs an address}"; shift 2 ;;
    --open|-o) OPEN=1; shift ;;
    --background|-b) BACKGROUND=1; shift ;;
    --stop) STOP=1; shift ;;
    --sw) REAL_SW=1; shift ;;
    # The comment block at the top is the help, so the two can never say different things.
    --help|-h) awk 'NR>1 && /^#/ { sub(/^# ?/, ""); print; next } NR>1 { exit }' "${BASH_SOURCE[0]}"; exit 0 ;;
    *) echo "run.sh: don't know the option $1 (try --help)" >&2; exit 2 ;;
  esac
done

# ---- stopping one left running ---------------------------------------------------------------
if [ "$STOP" = 1 ]; then
  if [ -f "$PIDFILE" ] && kill -0 "$(cat "$PIDFILE")" 2>/dev/null; then
    kill "$(cat "$PIDFILE")" && rm -f "$PIDFILE"
    echo "Stopped."
  else
    rm -f "$PIDFILE"
    echo "Nothing of ours was running."
  fi
  exit 0
fi

if [ -f "$PIDFILE" ] && kill -0 "$(cat "$PIDFILE")" 2>/dev/null; then
  echo "Already running in the background (pid $(cat "$PIDFILE")). Stop it with ./run.sh --stop." >&2
  exit 1
fi

command -v python3 >/dev/null || { echo "run.sh needs python3." >&2; exit 1; }

# ---- the server ---------------------------------------------------------------------------------
# Written here rather than reached for off the shelf because it has two jobs a plain static server does not do:
# it never serves Statements/ (bank statements and backups, kept out of the published site), and by default it
# answers /sw.js with a worker that takes itself off instead of the real one — the real one serves the scripts
# from its own copy keyed by their ?v= tag, so a local edit would go on showing the previous build until the tag
# was bumped by hand. --sw gives the real one back, for when the offline behaviour is what is being tested.
SERVER_PY="$(mktemp "${TMPDIR:-/tmp}/kajanauday-serve-XXXXXX")"
trap 'rm -f "$SERVER_PY"' EXIT

cat > "$SERVER_PY" <<'PY'
import os, sys, socket
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

ROOT, HOST, PORT, REAL_SW = sys.argv[1], sys.argv[2], int(sys.argv[3]), sys.argv[4] == '1'

# A service worker that unregisters itself and empties the cache, so a page served from here is always the files
# on disk. Served in place of sw.js unless the real one was asked for.
DEV_SW = b"""// Local development: this takes the real service worker off, so edits show at once.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', event => event.waitUntil((async () => {
  await Promise.all((await caches.keys()).map(name => caches.delete(name)));
  await self.registration.unregister();
  (await self.clients.matchAll({ type: 'window' })).forEach(client => client.navigate(client.url));
})()));
"""

class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=ROOT, **kwargs)

    def send_head(self):
        path = self.path.split('?', 1)[0].split('#', 1)[0]
        # Never out of this machine: these are bank statements and ledger backups, and the published site has
        # no copy of them. A typo in --host should not be what decides that.
        if path.lower().lstrip('/').startswith('statements'):
            self.send_error(404, 'Not found')
            return None
        if not REAL_SW and path in ('/sw.js', '/./sw.js'):
            self.send_response(200)
            self.send_header('Content-Type', 'application/javascript')
            self.send_header('Content-Length', str(len(DEV_SW)))
            self.send_header('Cache-Control', 'no-store')
            self.send_header('Service-Worker-Allowed', '/')
            self.end_headers()
            return __import__('io').BytesIO(DEV_SW)
        return super().send_head()

    def end_headers(self):
        # Nothing is kept by the browser either, for the same reason: what is on disk is what should be running.
        self.send_header('Cache-Control', 'no-store')
        super().end_headers()

    def log_message(self, fmt, *args):
        line = fmt % args
        # Each file as it is asked for is noise; a refusal or a mistake is not.
        if ' 200 ' not in line and ' 304 ' not in line:
            sys.stderr.write('  %s\n' % line)

# The port asked for, or the next free one after it: a server left over from a previous run should not stop this one.
for port in range(PORT, PORT + 20):
    try:
        ThreadingHTTPServer.allow_reuse_address = True
        server = ThreadingHTTPServer((HOST, port), Handler)
        break
    except OSError as error:
        if port == PORT + 19:
            sys.exit('No free port between %d and %d: %s' % (PORT, port, error))
        continue

shown = HOST if HOST not in ('0.0.0.0', '::') else (socket.gethostbyname(socket.gethostname()) or '127.0.0.1')
print('__READY__ http://%s:%d/' % (shown, port), flush=True)
try:
    server.serve_forever()
except KeyboardInterrupt:
    pass
PY

START_PAGE="kajanauday/months.html"

run_server() { python3 "$SERVER_PY" "$ROOT" "$HOST" "$PORT" "$REAL_SW"; }

if [ "$BACKGROUND" = 1 ]; then
  LOG="${TMPDIR:-/tmp}/kajanauday-run-$(id -u).log"
  run_server >"$LOG" 2>&1 &
  echo $! > "$PIDFILE"
  # Wait for it to say it is listening, so the address printed is one that answers.
  for _ in $(seq 1 50); do grep -q '__READY__' "$LOG" 2>/dev/null && break; sleep 0.1; done
  URL="$(sed -n 's/^__READY__ //p' "$LOG" | head -1)"
  if [ -z "$URL" ]; then
    echo "Could not start the server:" >&2; cat "$LOG" >&2; rm -f "$PIDFILE"; exit 1
  fi
  echo "Running in the background on ${URL}${START_PAGE}  (pid $(cat "$PIDFILE"))"
  echo "Log: $LOG · stop it with ./run.sh --stop"
  [ "$OPEN" = 1 ] && (xdg-open "${URL}${START_PAGE}" >/dev/null 2>&1 || open "${URL}${START_PAGE}" >/dev/null 2>&1 || true)
  # The server owns the script file now, so it must outlive this shell.
  trap - EXIT
  exit 0
fi

# In the foreground the ready line is turned into something worth reading and the rest is passed through.
run_server | while IFS= read -r line; do
  case "$line" in
    __READY__*)
      URL="${line#__READY__ }"
      echo
      echo "  Kajana Uday Expenses"
      echo "  ${URL}${START_PAGE}"
      [ "$HOST" = "0.0.0.0" ] && echo "  (reachable from this network — Statements/ is never served)"
      [ "$REAL_SW" = 1 ] && echo "  (the real service worker: bump the ?v= tags in months.html to see an edit)"
      echo
      echo "  Ctrl+C to stop."
      echo
      [ "$OPEN" = 1 ] && (xdg-open "${URL}${START_PAGE}" >/dev/null 2>&1 || open "${URL}${START_PAGE}" >/dev/null 2>&1 || true)
      ;;
    *) echo "$line" ;;
  esac
done
