#!/usr/bin/env bash
# Fake llama-server for admit measure tests.
# Accepts --port <n> (or --port=<n>); all other args are ignored.
# Serves GET /* → {"status":"ok"} on 127.0.0.1:<port>.
# Exits cleanly on SIGTERM.

PORT=18000
while [[ $# -gt 0 ]]; do
  case "$1" in
    --port) PORT="$2"; shift 2 ;;
    --port=*) PORT="${1#--port=}"; shift ;;
    *) shift ;;
  esac
done

python3 -c "
import http.server, json
class H(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        self.send_response(200)
        self.send_header('Content-Type', 'application/json')
        self.end_headers()
        self.wfile.write(json.dumps({'status': 'ok'}).encode())
    def log_message(self, *a): pass
http.server.HTTPServer(('127.0.0.1', ${PORT}), H).serve_forever()
" &
PY_PID=$!
trap "kill $PY_PID 2>/dev/null; exit 0" SIGTERM SIGINT
wait
