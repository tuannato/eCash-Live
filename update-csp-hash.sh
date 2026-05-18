#!/usr/bin/env bash
# =============================================================================
# update-csp-hash.sh
#
# Recompute the SHA-256 hash of the inline <script type="module"> block in an
# HTML file and update the matching `sha256-...` token in its CSP meta tag.
#
# Why: the Content-Security-Policy uses script hash pinning to make sure only
# the legitimate inline module can run. If you edit the script and forget to
# update the hash, the browser refuses to execute and the page renders blank.
#
# Usage:
#   ./update-csp-hash.sh [path-to-html]
#
# Default path: index.html (in the current directory).
#
# Run this every time you edit the inline module. The script is idempotent:
# running it when nothing changed leaves the file untouched.
# =============================================================================

set -euo pipefail

FILE="${1:-index.html}"

if [[ ! -f "$FILE" ]]; then
  echo "error: file not found: $FILE" >&2
  exit 1
fi

# Pick a python interpreter (python3 preferred).
PY=""
for candidate in python3 python; do
  if command -v "$candidate" >/dev/null 2>&1; then
    PY="$candidate"
    break
  fi
done
if [[ -z "$PY" ]]; then
  echo "error: python3 not found in PATH" >&2
  exit 1
fi

# All the regex / file IO happens in python so we don't depend on a fragile
# sed/grep pipeline. The script reads the file, computes the script hash,
# verifies the CSP meta tag exists, and rewrites only the sha256 token.
"$PY" <<PYEOF
import re, hashlib, base64, sys, os

path = "$FILE"
with open(path, 'r', encoding='utf-8') as f:
    html = f.read()

# There must be exactly one <script type="module"> ... </script> block.
matches = list(re.finditer(
    r'<script[^>]*type="module"[^>]*>(.*?)</script>',
    html, re.DOTALL))
if len(matches) != 1:
    print(f"error: expected 1 <script type=\"module\"> block, found {len(matches)}",
          file=sys.stderr)
    sys.exit(2)

script = matches[0].group(1)
new_hash = base64.b64encode(hashlib.sha256(script.encode('utf-8')).digest()).decode('ascii')

# Locate the CSP meta tag and the sha256 token inside it.
csp_re = re.compile(r'(<meta\s+http-equiv="Content-Security-Policy"[^>]*content="[^"]*?)sha256-[A-Za-z0-9+/=]+([^"]*?")', re.DOTALL)
m = csp_re.search(html)
if not m:
    print("error: could not locate sha256-... inside CSP meta tag", file=sys.stderr)
    sys.exit(3)

current = re.search(r'sha256-([A-Za-z0-9+/=]+)', m.group(0)).group(1)
if current == new_hash:
    print(f"unchanged: sha256-{new_hash}")
    sys.exit(0)

new_html = csp_re.sub(lambda mo: mo.group(1) + 'sha256-' + new_hash + mo.group(2),
                      html, count=1)

# Atomic write: tmp file + rename.
tmp = path + '.tmp'
with open(tmp, 'w', encoding='utf-8') as f:
    f.write(new_html)
os.replace(tmp, path)

print(f"old: sha256-{current}")
print(f"new: sha256-{new_hash}")
print(f"✓ updated {path}")
PYEOF
