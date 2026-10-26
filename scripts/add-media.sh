#!/bin/bash
# Puts local files into a project's Media pool in Our Editor (the browser CapCut-style editor).
#
#   add-media.sh [--aspect 16:9] [--place '<json>'] "<project name>" [<file> ...]
#
# --place: JSON array of timeline placements, run after the import (files are optional then: the
#   clips can already be in the pool). Each: {"asset": "<pool file name>",
#   "track": "<track id>" | "main" | "overlay" | {"newAbove": "<track id>" | "$prev"},
#   "at": <seconds> | "$prevStart" | {"afterTrackEnd": "<track id>" | "$prev"}}. "$prev" = the track
#   of the previous placement, "$prevStart" = its start time (stack takes to compare them). Track ids: see ~/.our-editor/library/projects/<project id>.json. The result JSON lists
#   where every clip landed ("placed").
#
# The project is opened by name (created when it does not exist; --aspect applies to a new one).
# Files must be under ~/Desktop/ai or ~/Movies/CapCut. Starts the dev server and opens the editor
# window when needed, waits for the editor to take the request, prints the result JSON.
# Exit 0 = all files in the pool, 1 = some failed, 2 = usage, 3 = the editor never picked it up.
set -euo pipefail
export PATH="/usr/local/bin:/opt/homebrew/bin:$PATH"
PORT="${OUR_EDITOR_PORT:-5173}"
URL="http://localhost:$PORT"
INBOX="$HOME/.our-editor/inbox/$PORT"   # one inbox per editor server (vite-plugins/localFiles.js)
APP="$HOME/Applications/Our Editor.app"
ASPECT=""
PLACE=""
while [[ "${1:-}" == --* ]]; do
  case "$1" in
    --aspect) ASPECT="$2"; shift 2 ;;
    --place) PLACE="$2"; shift 2 ;;
    *) echo "Unknown option $1" >&2; exit 2 ;;
  esac
done
if [[ $# -lt 1 || ( $# -lt 2 && -z "$PLACE" ) ]]; then sed -n 2,19p "$0" | sed 's/^# \{0,1\}//'; exit 2; fi
PROJECT="$1"; shift

FILES=()
for f in "$@"; do
  [[ -f "$f" ]] || { echo "Not a file: $f" >&2; exit 2; }
  FILES+=("$(cd "$(dirname "$f")" && pwd -P)/$(basename "$f")")
done

mkdir -p "$INBOX"
ID="req-$(date +%s)-$$"
python3 - "$INBOX/$ID.json" "$PROJECT" "$ASPECT" "$PLACE" "${FILES[@]+"${FILES[@]}"}" <<'PY'
import json, os, sys
out, project, aspect, place, *files = sys.argv[1:]
req = {"project": project, "aspect": aspect or None, "files": files}
if place:
    req["place"] = json.loads(place)  # fails loudly on bad JSON, before anything is sent
tmp = out + ".tmp"
json.dump(req, open(tmp, "w"), ensure_ascii=False, indent=2)
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
