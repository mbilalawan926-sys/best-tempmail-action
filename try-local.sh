#!/usr/bin/env bash
# Runs the Action against the REAL API, the way a GitHub runner would.
#
# Mocks agree with whatever the author assumed. The link extractor passed 18
# hand-written tests and then returned a footer link on the first real email it
# ever saw, so nothing here ships on green mocks alone.
#
#   BTM_KEY=btm_sk_live_... bash try-local.sh
#
# It creates a real inbox on your account, waits briefly for mail (there will
# not be any, so that step is expected to report nothing found), and deletes
# the inbox again. Costs 2 requests of quota plus the wait.

set -u

if [ -z "${BTM_KEY:-}" ]; then
  echo "Set BTM_KEY first:  BTM_KEY=btm_sk_live_... bash try-local.sh"
  exit 2
fi

HERE="$(cd "$(dirname "$0")" && pwd)"
OUT="$(mktemp)"
export GITHUB_OUTPUT="$OUT"

show() { echo "--- outputs:"; sed 's/^/    /' "$OUT"; : > "$OUT"; }

echo "=============================================================="
echo " 1. create"
echo "=============================================================="
env "INPUT_API-KEY=$BTM_KEY" INPUT_OPERATION=create node "$HERE/index.js"
CODE=$?
ADDR="$(grep -A1 '^address<<' "$OUT" | tail -1)"
show
echo "    exit: $CODE    address: $ADDR"
if [ "$CODE" -ne 0 ] || [ -z "$ADDR" ]; then
  echo "create failed, stopping"
  exit 1
fi

echo
echo "=============================================================="
echo " 2. wait, 8s, expecting nothing (fail-if-no-mail false)"
echo "=============================================================="
env "INPUT_API-KEY=$BTM_KEY" INPUT_OPERATION=wait "INPUT_ADDRESS=$ADDR" \
    INPUT_TIMEOUT=8 "INPUT_FAIL-IF-NO-MAIL=false" node "$HERE/index.js"
echo "    exit: $?"
show

echo
echo "=============================================================="
echo " 3. wait with a filter, 6s, expecting nothing"
echo "=============================================================="
env "INPUT_API-KEY=$BTM_KEY" INPUT_OPERATION=wait "INPUT_ADDRESS=$ADDR" \
    INPUT_TIMEOUT=6 "INPUT_SUBJECT-CONTAINS=verify" "INPUT_FAIL-IF-NO-MAIL=false" \
    node "$HERE/index.js"
echo "    exit: $?"
show

echo
echo "=============================================================="
echo " 4. delete"
echo "=============================================================="
env "INPUT_API-KEY=$BTM_KEY" INPUT_OPERATION=delete "INPUT_ADDRESS=$ADDR" node "$HERE/index.js"
echo "    exit: $?"

echo
echo "=============================================================="
echo " 5. delete again, should say 'already gone' and exit 0"
echo "=============================================================="
env "INPUT_API-KEY=$BTM_KEY" INPUT_OPERATION=delete "INPUT_ADDRESS=$ADDR" node "$HERE/index.js"
echo "    exit: $?"

rm -f "$OUT"
echo
echo "Done. To test a real message end to end, create an inbox, sign up to"
echo "something with that address, then run step 2 again while the mail is on"
echo "its way: the otp and action-url outputs are the ones worth seeing."
