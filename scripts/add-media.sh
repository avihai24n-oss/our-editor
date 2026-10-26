#!/bin/bash
# Puts local files into a project's Media pool in Our Editor (the browser CapCut-style editor).
#
#   add-media.sh [--aspect 16:9] "<project name>" <file> [<file> ...]
#
# The project is opened by name (created when it does not exist; --aspect applies to a new one).
# Files must be under ~/Desktop/ai or ~/Movies/CapCut. Starts the dev server and opens the editor
# window when needed, waits for the editor to take the request, prints the result JSON.
# Exit 0 = all files in the pool, 1 = some failed, 2 = usage, 3 = the editor never picked it up.
set -euo pipefail
export PATH="/usr/local/bin:/opt/homebrew/bin:$PATH"
URL="http://localhost:5173"
INBOX="$HOME/.our-editor/inbox"
APP="$HOME/Applications/Our Editor.app"
ASPECT=""
if [[ "${1:-}" == "--aspect" ]]; then ASPECT="$2"; shift 2; fi
if [[ $# -lt 2 ]]; then sed -n 2,10p "$0" | sed 's/^# \{0,1\}//'; exit 2; fi
PROJECT="$1"; shift

FILES=()
for f in "$@"; do
  [[ -f "$f" ]] || { echo "Not a file: $f" >&2; exit 2; }
  FILES+=("$(cd "$(dirname "$f")" && pwd -P)/$(basename "$f")")
done

mkdir -p "$INBOX"
ID="req-$(date +%s)-$$"
python3 - "$INBOX/$ID.json" "$PROJECT" "$ASPECT" "${FILES[@]}" <<'PY'
import json, os, sys
out, project, aspect, *files = sys.argv[1:]
tmp = out + ".tmp"
json.dump({"project": project, "aspect": aspect or None, "files": files}, open(tmp, "w"), ensure_ascii=False, indent=2)
os.rename(tmp, out)  # atomic: the editor never sees half a request
PY

DONE="$INBOX/done/$ID.json"
wait_done() { for _ in $(seq 1 $(( $1 * 2 ))); do [[ -f "$DONE" ]] && return 0; sleep 0.5; done; return 1; }

if ! curl -s -o /dev/null "$URL" || ! wait_done 6; then
  echo "Editor not open — launching it…" >&2
  open "$APP"
  if ! wait_done 120; then
    echo "The editor did not pick up the request (still in $INBOX/$ID.json; it runs next time the editor opens)." >&2
    exit 3
  fi
fi

python3 -c 'import json,sys; d=json.load(open(sys.argv[1]))["result"]; print(json.dumps(d, ensure_ascii=False, indent=2)); sys.exit(0 if d.get("ok") else 1)' "$DONE"
