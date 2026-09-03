#!/usr/bin/env bash
# Owner-run distinct-UID check for the agent worker peer gate (task-5 brief addendum §3).
#
# Starts a test-only worker socket (real native getpeereid addon) at a temporary path,
# then connects once as the current user and once as ANOTHER local user via `sudo -u`.
# Expected: same user gets a `health` reply; the other user gets no reply and the
# connection is closed by the peer gate (audit class PEER_UID_MISMATCH).
#
# The implementer never runs sudo; the owner runs:
#   scripts/agent-worker-peer-uid-check.sh <other-local-username>
#
# Because the production socket is 0600 inside a 0700 directory, another user cannot
# even reach it; to exercise the UID gate itself this harness relaxes ONLY its own
# temporary directory/socket modes after start. It never touches the real socket path.
set -euo pipefail

OTHER_USER="${1:-}"
if [[ -z "$OTHER_USER" ]]; then
  echo "usage: $0 <other-local-username>" >&2
  exit 2
fi
if [[ "$OTHER_USER" == "$(id -un)" ]]; then
  echo "FAIL: other user must differ from the current user ($OTHER_USER)" >&2
  exit 2
fi

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

if [[ ! -f src/lib/agent-worker/native/peer-cred/build/Release/peer_cred.node ]]; then
  echo "FAIL: native addon not built; run: npm run agent-worker:build-native" >&2
  exit 2
fi

WORK_DIR="$(mktemp -d /tmp/wag-peer-uid.XXXXXX)"
SOCKET_PATH="$WORK_DIR/w/s.sock"
trap 'kill "${HARNESS_PID:-0}" 2>/dev/null || true; rm -rf "$WORK_DIR"' EXIT

WAG_AGENT_WORKER_SOCKET="$SOCKET_PATH" WAG_PEER_UID_HARNESS_RELAX_MODES=1 \
  ./node_modules/.bin/tsx scripts/agent-worker-peer-uid-harness.ts > "$WORK_DIR/harness.log" 2>&1 &
HARNESS_PID=$!

for _ in $(seq 1 50); do
  if grep -q '"event":"ready"' "$WORK_DIR/harness.log" 2>/dev/null; then break; fi
  sleep 0.1
done
if ! grep -q '"event":"ready"' "$WORK_DIR/harness.log"; then
  echo "FAIL: harness did not become ready" >&2
  cat "$WORK_DIR/harness.log" >&2
  exit 1
fi

CLIENT='const net=require("node:net");const p=process.argv[1];const s=net.connect(p);let got="";
s.on("connect",()=>s.write(JSON.stringify({id:"h",method:"health",params:{}})+"\n"));
s.on("data",(d)=>{got+=d.toString();});
s.on("error",(e)=>{console.log("ERROR "+e.code);process.exit(0);});
s.on("close",()=>{console.log(got.trim().length?("REPLY "+got.trim()):"NO_REPLY");});
setTimeout(()=>{s.destroy();},2000);'

SAME=$(node -e "$CLIENT" "$SOCKET_PATH")
OTHER=$(sudo -u "$OTHER_USER" /usr/local/bin/node -e "$CLIENT" "$SOCKET_PATH" 2>/dev/null || echo "SUDO_FAILED")

echo "same-user : $SAME"
echo "other-user: $OTHER"

kill "$HARNESS_PID" 2>/dev/null || true
wait "$HARNESS_PID" 2>/dev/null || true

if [[ "$SAME" == REPLY* && "$SAME" == *'"ok":true'* ]] \
   && [[ "$OTHER" == "NO_REPLY" ]] \
   && grep -q 'PEER_UID_MISMATCH' "$WORK_DIR/harness.log"; then
  echo "PASS: same-uid served, distinct-uid destroyed by the peer gate"
  exit 0
fi

echo "FAIL: see harness log below" >&2
cat "$WORK_DIR/harness.log" >&2
exit 1
