#!/usr/bin/env bash
# One-shot browser verification: real Chrome, real DOM, scripted scenarios.
#
#   npm run verify
#   SCENARIOS="play hint" npm run verify
#   BASE_URL=https://z-biz-game.github.io/z-biz-game-tapa-cos/ npm run verify
#   SHOTS=1 npm run verify          # also writes tools/shots/*.png
#
# Do NOT add --use-gl=angle --use-angle=swiftshader --enable-unsafe-swiftshader: software
# rasterisation saturates every core and, with no CDP client attached, Chrome will not exit
# on its own.
set -u
HERE=$(cd "$(dirname "$0")/.." && pwd)
# 5312 is this game's port in the org's table and 9362 the DevTools in front of it. Sibling repos
# (斜钉 5252/9349, 数回, 四叶…) run their own verify.sh on this machine at the same minute, so the
# pair is hard-coded: nothing here may be pointed at another repo's server by accident.
HTTP=${HTTP_PORT:-5312}
PORT=${CDP_PORT:-9362}
BASE=${BASE_URL:-http://127.0.0.1:$HTTP/}
CHROME=${CHROME_BIN:-}
if [ -z "$CHROME" ]; then
  for c in "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
           "/Applications/Chromium.app/Contents/MacOS/Chromium" \
           google-chrome chromium chromium-browser; do
    if command -v "$c" >/dev/null 2>&1 || [ -x "$c" ]; then CHROME=$c; break; fi
  done
fi
[ -x "$CHROME" ] || { echo "no Chrome found; set CHROME_BIN" >&2; exit 2; }

LOCAL=0
case "$BASE" in "http://127.0.0.1:$HTTP/"*) LOCAL=1 ;; esac
# Refuse to run on top of ports somebody else already owns. An orphan server from a sibling repo's
# verify.sh would answer the pre-flight curl with its own index.html, and every scenario below would
# then be asserting against a different game.
if command -v lsof >/dev/null 2>&1; then
  for p in $([ "$LOCAL" = 1 ] && echo "$HTTP") "$PORT"; do
    if lsof -nP -iTCP:"$p" -sTCP:LISTEN 2>/dev/null | grep -q LISTEN; then
      echo "port $p is already being listened on:" >&2
      lsof -nP -iTCP:"$p" -sTCP:LISTEN >&2 | tail -3
      echo "kill the orphan (or set HTTP_PORT/CDP_PORT) — this harness only trusts servers it starts itself" >&2
      exit 2
    fi
  done
fi
SPID=0
if [ "$LOCAL" = 1 ]; then
  node "$HERE/server.cjs" "$HTTP" >/tmp/tapa-server.log 2>&1 &
  SPID=$!
  for i in $(seq 1 40); do
    curl -fsS -m 1 "http://127.0.0.1:$HTTP/" >/dev/null 2>&1 && break
    sleep 0.25
  done
fi
# Pre-flight: prove the bytes we are about to assert on are this app's index.html and not some
# long-lived server from another repo that happens to own the port.
SERVED=$(curl -fsS -m 3 "$BASE" 2>/dev/null || true)
case "$SERVED" in *js/main.js*) ;; *) echo "nothing served at $BASE (see /tmp/tapa-server.log)" >&2; exit 2 ;; esac
echo "$SERVED" | grep -qi tapa || { echo "port $HTTP is serving a different app, not 视窗/tapa" >&2; exit 2; }
echo "pre-flight: $BASE serves 视窗 · Tapa"

UDD=$(mktemp -d)
"$CHROME" --headless=new --remote-debugging-port=$PORT --user-data-dir=$UDD \
  --window-size=900,900 --no-first-run --no-default-browser-check about:blank >/tmp/tapa-chrome.log 2>&1 &
CPID=$!
cleanup() {
  [ "$SPID" != 0 ] && kill $SPID 2>/dev/null
  kill -9 $CPID 2>/dev/null
  rm -rf $UDD
}
trap cleanup EXIT
# The watchdog redirects its fds: a background subshell inherits this script's stdout, and inside a
# pipeline it would hold the write end open long after the tests finished.
( sleep ${WD_TIMEOUT:-420}; cleanup ) </dev/null >/dev/null 2>&1 & WD=$!

# A fresh --user-data-dir binds DevTools later than a warm profile: wait on the endpoint, not on a
# fixed sleep.
for i in $(seq 1 120); do
  curl -fsS -m 1 "http://127.0.0.1:$PORT/json/version" >/dev/null 2>&1 && break
  sleep 0.5
done
curl -fsS -m 2 "http://127.0.0.1:$PORT/json/version" >/dev/null 2>&1 || {
  echo "devtools never bound on :$PORT (see /tmp/tapa-chrome.log)" >&2; exit 3; }

export CDP_PORT=$PORT
export BASE_URL=$BASE
cd "$HERE"
node tools/playtest.cjs open "$BASE" | head -5

BOOT=""
for i in $(seq 1 60); do
  BOOT=$(node tools/playtest.cjs eval "window.tapa?window.tapa.version:'nope'" nonav 2>/dev/null | tr -d '\n" ')
  case "$BOOT" in *nope*|"") sleep 0.5 ;; *) break ;; esac
done
echo "boot: tapa $BOOT at $BASE"
[ "$BOOT" = "nope" ] && { echo "window.tapa never appeared at $BASE" >&2; exit 4; }

FAILED=0
for s in ${SCENARIOS:-engine gen library play ink hint conflict zero save resume pause layout}; do
  echo "=== $s ==="
  node tools/playtest.cjs scenario "$s" 2>/tmp/tapa-$s.console.log | tail -1 | sed 's/^RESULT //' | python3 -c "
import sys, json
raw = sys.stdin.read().strip()
if not raw:
    print('  NO RESULT (see /tmp/tapa-$s.console.log)'); sys.exit(1)
try:
    d = json.loads(raw)
except Exception:
    print('  UNPARSED:', raw[:300]); sys.exit(1)
for r in d['rows']:
    if not r['pass']: print('  FAIL %-46s %s' % (r['test'], r['detail']))
extra = {k: v for k, v in d.items() if k not in ('rows', 'fail')}
if not d['rows']:
    print('  NO CHECKS RUN — a scenario that asserts nothing cannot be green'); sys.exit(1)
print('  %d checks, %d failed  %s' % (len(d['rows']), d['fail'], extra if extra else ''))
sys.exit(1 if d['fail'] else 0)
" || FAILED=1
  if [ -s /tmp/tapa-$s.console.log ]; then
    echo "  --- console ---"
    sed 's/^/  /' /tmp/tapa-$s.console.log | tail -12
  fi
done

if [ -n "${SHOTS:-}" ]; then
  mkdir -p tools/shots
  for shot in menu board win; do
    case $shot in
      menu) node tools/playtest.cjs eval "window.tapa.show('menu');'ok'" nonav >/dev/null 2>&1 ;;
      board) node tools/playtest.cjs eval "window.tapa.begin({tier:'master',seed:'shot-board'});for(let i=0;i<12;i++)window.tapa.useHint();'ok'" nonav >/dev/null 2>&1 ;;
      win) node tools/playtest.cjs eval "window.tapa.begin({tier:'hard',seed:'shot-win'});window.tapa.solveWithLogic();'ok'" nonav >/dev/null 2>&1 ;;
    esac
    sleep 1.4
    node tools/playtest.cjs shot tools/shots/$shot-$SHOTS.png >/dev/null
  done
  echo "shots: $(ls tools/shots/*-$SHOTS.png | tr '\n' ' ')"
fi

kill $WD 2>/dev/null
# 部署集闸：ci.yml 跑这两步、本地整闸以前一次都不跑。缺这一步就是「本地全绿、线上 404 自己的
# manifest / sw.js / 图标」这一整类坏法。它不碰 Chrome，也不读页面，纯查产物。
echo "=== deploy-set ==="
node tools/deploy-set.mjs || FAILED=1
node tools/deploy-set-selftest.mjs || FAILED=1
[ $FAILED -eq 0 ] && echo "=== ALL GREEN ===" || echo "=== FAILURES ABOVE ==="
exit $FAILED
