#!/usr/bin/env python3
"""
project-index.py — eCash Live repository indexer.

Regenerates PROJECT_INDEX.md: a current, machine-built navigation map of the
whole project, with special depth on the large files (index.html ~21.5k lines,
ttf-relay.py, ecash_bot.py, echan.js, mediacenter.js).

WHY THIS EXISTS
  Line numbers in index.html's inline module drift on EVERY web edit, so the
  hardcoded `file:line` anchors in CLAUDE.md go stale. This script reads the
  files directly and emits fresh anchors, structural spans, section banners and
  function/def line numbers each time it runs. Trust PROJECT_INDEX.md over any
  stale number — and regenerate after editing index.html / the relay / the bot.

USAGE
  python3 project-index.py            # writes ./PROJECT_INDEX.md
  python3 project-index.py --stdout   # print to stdout instead of writing
  python3 project-index.py --check    # exit 1 if PROJECT_INDEX.md is out of date

Zero dependencies. Pure stdlib. Safe to run any time — only ever writes
PROJECT_INDEX.md, never touches source files.
"""

from __future__ import annotations

import os
import re
import sys
import datetime

ROOT = os.path.dirname(os.path.abspath(__file__))
OUT_NAME = "PROJECT_INDEX.md"

# ---------------------------------------------------------------------------
# Curated one-line purpose for known paths. Anything not listed still appears
# in the file tree (without a blurb), so new files are never hidden.
# ---------------------------------------------------------------------------
PURPOSE = {
    "index.html": "The entire web app: HTML + pinned inline <style> + inline ES module. GitHub Pages.",
    "ttf-relay.py": "VPS asyncio relay. Tails bitcoind debug.log, pairs mempool+finalize, computes µs TTF, WS broadcast + 24h stats ring.",
    "ecash_bot.py": "Telegram node-ops bot. Status + password-gated restart/stop/start/update. Reads relay's ttf-stats.json (not the WS).",
    "update-csp-hash.sh": "Rewrites the CSP sha256- token for index.html's inline module. Run after ANY module edit.",
    "CLAUDE.md": "Operating manual for AI-assisted work. Auto-loads at session start.",
    "README.md": "Repository layout + overview.",
    "ECASH_TECHNICAL.md": "eCash protocol concepts + how this repo consumes them.",
    "SECURITY.md": "Full threat model + security conventions.",
    "VENDOR.md": "Provenance/licensing of self-hosted /vendor assets.",
    "CNAME": "GitHub Pages custom domain (ecashlive.net).",
    "site.webmanifest": "PWA manifest.",
    "vendor/chronik-client.js": "Self-hosted Chronik client (tx/block/msg feeds over HTTP+WS).",
    "vendor/qrcode.js": "Self-hosted QR renderer.",
    "vendor/qrcode-generator.js": "Self-hosted QR data generator.",
    "vendor/fonts.css": "@font-face declarations for self-hosted Space Grotesk / Fira Code woff2.",
    "vendor/companion/echan.js": "eChan: deterministic offline companion controller. Narrates network activity from the stats feed. No runtime LLM.",
    "vendor/companion/echan.css": "eChan UI styling.",
    "vendor/companion/seed.json": "eChan base dialog lines. Edits usually touch all seed.<lang>.json too (keep keys/line-counts identical).",
    "vendor/mediacenter/mediacenter.js": "Media center controller (lessons / cards / video).",
    "vendor/mediacenter/mediacenter.css": "Media center styling.",
    "internal/CLAUDE.md": "Prior current manual (partly redundant with root CLAUDE.md).",
    "internal/CLAUDE_CODE_SUPPLEMENT.md": "STALE supplement (old line numbers/filenames) — trust root CLAUDE.md.",
    "internal/AGENTS.md": "Governs non-Claude agents (Grok) + full content rules.",
    "internal/eCash_Avalanche_Technical_Reference.md": "Source-verified bitcoin-abc Avalanche constants.",
    "internal/ttf-relay.service": "systemd unit for the relay.",
    "internal/ttf-relay-logrotate.conf": "logrotate config for relay logs.",
    "internal/ttf-relay.service.d": "systemd drop-ins for the relay.",
    "internal/nginx-scanner-block.conf": "nginx rules blocking scanner noise.",
    "internal/ecash_bot.py": "Mirror of root ecash_bot.py (should be byte-identical).",
    "internal/eChanLesson.html": "Standalone eChan lesson page (English-only — Vietnamese stripped 2026-06-25).",
    "internal/eChanLesson-wide.html": "Wide-layout variant of the eChan lesson page.",
    "internal/consensus-radar-demo.html": "Standalone demo of the Consensus Radar (shipped in index.html v1.5.0).",
    "internal/fetch-yt.js": "Helper to fetch YouTube card metadata/thumbnails.",
    "internal/test_hourly_3days.py": "Offline test harness for hourly rollups over 3 days.",
    "internal/test_ttf_distribution.py": "Offline test harness for TTF percentile distribution.",
}

# Directories never worth walking into file-by-file (summarized instead).
BULK_DIRS = {
    "vendor/fonts": "self-hosted woff2 (Space Grotesk + Fira Code)",
    "vendor/i18n": "UI strings, one JSON per language",
    "vendor/companion/sprites": "eChan sprite frames (.webp)",
    "vendor/mediacenter/cards": "media-center thumbnails (.webp/.jpg)",
}
SKIP_DIRS = {".git", ".claude", "__pycache__", "node_modules", ".idea", ".vscode"}
SKIP_FILE_RE = re.compile(r"\.(bak|bak\..*|pyc|swp)$|\.bak\.\d", re.IGNORECASE)
BINARY_EXT = {".png", ".ico", ".woff2", ".webp", ".jpg", ".jpeg", ".mp3", ".gif"}


def rel(p: str) -> str:
    return os.path.relpath(p, ROOT).replace(os.sep, "/")


def read_lines(path: str):
    with open(path, "r", encoding="utf-8", errors="replace") as fh:
        return fh.read().split("\n")


# ---------------------------------------------------------------------------
# index.html parsing
# ---------------------------------------------------------------------------
def find_first(lines, pattern, start=0):
    rx = re.compile(pattern)
    for i in range(start, len(lines)):
        if rx.search(lines[i]):
            return i + 1  # 1-based
    return None


def index_html_structure(lines):
    """Return ordered (label, line) structural landmarks."""
    spans = []
    landmarks = [
        ("<head>", r"<head>"),
        ("<style> (pinned inline CSS) begins", r"^\s*<style>"),
        ("</style>", r"^\s*</style>"),
        ("</head>", r"</head>"),
        ("<body>", r"<body>"),
        ('<script type="module"> (inline app) begins', r'<script[^>]*type="module"'),
        ("</script> (inline module ends)", r"</script>"),
        ("</body>", r"</body>"),
    ]
    used = 0
    for label, pat in landmarks:
        ln = find_first(lines, pat, used)
        if ln:
            spans.append((label, ln))
            used = ln  # keep landmarks in document order
    return spans


CSS_BANNER_RE = re.compile(r"^\s*/\*\s*=+\s*(.+?)\s*=+\s*\*/\s*$")
JS_INLINE_BANNER_RE = re.compile(r"^\s*//\s*=+\s*(.+?)\s*=+\s*$")
JS_DIVIDER_RE = re.compile(r"^\s*//\s*=+\s*$")          # // ===============
JS_COMMENT_TEXT_RE = re.compile(r"^\s*//\s*(\S.*?)\s*$")  # // Some title
# function foo(  |  async function foo(  |  const foo = (...) =>  |  const foo = async (...) =>
JS_FUNC_RE = re.compile(
    r"^(?P<indent>\s*)(?:export\s+)?"
    r"(?:(?:async\s+)?function\s+(?P<fn>[A-Za-z_$][\w$]*)"
    r"|(?:const|let|var)\s+(?P<cn>[A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>)"
)


def _is_divider_text(s):
    """True if the captured text is just a run of separators (=, -, space)."""
    return not s.strip("=-_ ·•").strip()


def scan_js_banners(lines, start, end):
    """Section banners within [start,end) (1-based inclusive). Handles two styles:
       inline `// ==== TITLE ====` and 3-line box `// ====\n// TITLE\n// ====`."""
    out = []
    n = min(end, len(lines))
    i = start - 1
    while i < n:
        line = lines[i]
        # Box banner: divider / title / divider
        if JS_DIVIDER_RE.match(line) and i + 2 < n and JS_DIVIDER_RE.match(lines[i + 2]):
            mt = JS_COMMENT_TEXT_RE.match(lines[i + 1])
            if mt and not _is_divider_text(mt.group(1)):
                out.append((mt.group(1).strip(), i + 2))  # point at the title line
                i += 3
                continue
        m = JS_INLINE_BANNER_RE.match(line)
        if m and not _is_divider_text(m.group(1)):
            out.append((m.group(1).strip(), i + 1))
        i += 1
    return out


def scan_css_banners(lines, start, end):
    out = []
    for i in range(start - 1, min(end, len(lines))):
        m = CSS_BANNER_RE.match(lines[i])
        if m:
            out.append((m.group(1).strip(), i + 1))
    return out


def scan_js_funcs(lines, start, end, max_indent=4):
    """Top-level-ish function/const-arrow declarations in [start,end)."""
    out = []
    for i in range(start - 1, min(end, len(lines))):
        m = JS_FUNC_RE.match(lines[i])
        if not m:
            continue
        if len(m.group("indent")) > max_indent:
            continue
        name = m.group("fn") or m.group("cn")
        out.append((name, i + 1))
    return out


# ---------------------------------------------------------------------------
# Python parsing
# ---------------------------------------------------------------------------
PY_DEF_RE = re.compile(r"^(?P<indent>\s*)(?P<kind>class|async def|def)\s+(?P<name>[A-Za-z_]\w*)")


def scan_python(lines):
    out = []
    for i, line in enumerate(lines):
        m = PY_DEF_RE.match(line)
        if not m:
            continue
        indent = len(m.group("indent"))
        out.append((m.group("kind"), m.group("name"), i + 1, indent))
    return out


# ---------------------------------------------------------------------------
# File tree
# ---------------------------------------------------------------------------
def build_tree():
    rows = []  # (relpath, is_dir, purpose, size)
    bulk_summaries = []
    for dirpath, dirnames, filenames in os.walk(ROOT):
        dirnames[:] = sorted(d for d in dirnames if d not in SKIP_DIRS)
        rp = rel(dirpath)
        if rp == ".":
            rp = ""
        # bulk-summarize known asset dirs
        if rp in BULK_DIRS:
            count = len([f for f in filenames if not SKIP_FILE_RE.search(f)])
            bulk_summaries.append((rp, count, BULK_DIRS[rp]))
            dirnames[:] = []  # don't descend
            continue
        for f in sorted(filenames):
            if SKIP_FILE_RE.search(f):
                continue
            if rp == "" and f == OUT_NAME:
                continue  # don't index our own generated output (self-reference)
            full = os.path.join(dirpath, f)
            r = rel(full)
            try:
                size = os.path.getsize(full)
            except OSError:
                size = 0
            rows.append((r, PURPOSE.get(r, ""), size))
    rows.sort()
    return rows, sorted(bulk_summaries)


def human(n):
    for unit in ("B", "K", "M"):
        if n < 1024:
            return f"{n:.0f}{unit}"
        n /= 1024
    return f"{n:.0f}G"


# ---------------------------------------------------------------------------
# Report generation
# ---------------------------------------------------------------------------
def md_anchor(path, line=None):
    if line:
        return f"[{path}:{line}]({path}#L{line})"
    return f"[{path}]({path})"


def section_index_html(buf):
    path = "index.html"
    full = os.path.join(ROOT, path)
    if not os.path.exists(full):
        return
    lines = read_lines(full)
    total = len(lines)
    buf.append(f"## index.html — {total:,} lines\n")
    buf.append(
        "The whole web app in one file: HTML, a CSP-pinned inline `<style>`, and a "
        "large inline `<script type=\"module\">`. **Line numbers below are live as of "
        "the timestamp at the top — rerun `project-index.py` after any edit.**\n"
    )

    # Structural spans
    spans = index_html_structure(lines)
    buf.append("### Structural spans\n")
    for label, ln in spans:
        buf.append(f"- `{ln:>6}`  {label}")
    buf.append("")

    # Resolve module + style ranges from spans
    def span_line(substr):
        for label, ln in spans:
            if substr in label:
                return ln
        return None

    style_start = span_line("<style>") or 1
    style_end = span_line("</style>") or total
    mod_start = span_line('"module"') or 1
    mod_end = span_line("inline module ends") or total

    # CSS banners
    css = scan_css_banners(lines, style_start, style_end)
    buf.append(f"### Inline CSS sections  (`<style>` {style_start}–{style_end}, {len(css)} banners)\n")
    for name, ln in css:
        buf.append(f"- `{ln:>6}`  {name}")
    buf.append("")

    # Module banners
    mbanners = scan_js_banners(lines, mod_start, mod_end)
    buf.append(
        f"### Inline module sections  (`<script type=\"module\">` {mod_start}–{mod_end}, "
        f"{len(mbanners)} banners)\n"
    )
    for name, ln in mbanners:
        buf.append(f"- `{ln:>6}`  {name}")
    buf.append("")

    # Module functions
    funcs = scan_js_funcs(lines, mod_start, mod_end)
    buf.append(f"### Inline module functions / arrow consts  ({len(funcs)} found, indent ≤ 4)\n")
    buf.append("<details><summary>expand function index</summary>\n")
    # column-pack: name (line)
    for name, ln in funcs:
        buf.append(f"- `{ln:>6}`  `{name}`")
    buf.append("\n</details>\n")


def section_python(buf, path):
    full = os.path.join(ROOT, path)
    if not os.path.exists(full):
        return
    lines = read_lines(full)
    defs = scan_python(lines)
    classes = [d for d in defs if d[0] == "class"]
    funcs = [d for d in defs if d[0] != "class"]
    buf.append(f"## {path} — {len(lines):,} lines  ({len(classes)} classes, {len(funcs)} defs)\n")
    if path in PURPOSE:
        buf.append(PURPOSE[path] + "\n")
    for kind, name, ln, indent in defs:
        pad = "  " * (indent // 4) if indent else ""
        tag = "class" if kind == "class" else ("async def" if kind == "async def" else "def")
        buf.append(f"- `{ln:>5}`  {pad}{tag} `{name}`")
    buf.append("")


def section_js_file(buf, path):
    full = os.path.join(ROOT, path)
    if not os.path.exists(full):
        return
    lines = read_lines(full)
    total = len(lines)
    banners = scan_js_banners(lines, 1, total)
    funcs = scan_js_funcs(lines, 1, total, max_indent=2)
    buf.append(f"## {path} — {total:,} lines  ({len(banners)} banners, {len(funcs)} top-level fns)\n")
    if path in PURPOSE:
        buf.append(PURPOSE[path] + "\n")
    if banners:
        buf.append("### Section banners\n")
        for name, ln in banners:
            buf.append(f"- `{ln:>6}`  {name}")
        buf.append("")
    if funcs:
        buf.append("### Top-level functions\n")
        buf.append("<details><summary>expand</summary>\n")
        for name, ln in funcs:
            buf.append(f"- `{ln:>6}`  `{name}`")
        buf.append("\n</details>\n")


def section_tree(buf):
    rows, bulk = build_tree()
    buf.append("## File tree (curated)\n")
    buf.append("One line per tracked file (`.bak`/binary caches omitted). Blurbs are curated; "
               "unlisted files still appear so nothing is hidden.\n")
    cur_dir = None
    for r, purpose, size in rows:
        d = os.path.dirname(r) or "(root)"
        if d != cur_dir:
            buf.append(f"\n**{d}/**\n" if d != "(root)" else "\n**(repo root)**\n")
            cur_dir = d
        name = os.path.basename(r)
        blurb = f" — {purpose}" if purpose else ""
        buf.append(f"- `{name}` ({human(size)}){blurb}")
    if bulk:
        buf.append("\n**Bulk asset directories (summarized):**\n")
        for rp, count, desc in bulk:
            buf.append(f"- `{rp}/` — {count} files — {desc}")
    buf.append("")


def build_report():
    now = datetime.datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    buf = []
    buf.append("# PROJECT_INDEX.md — eCash Live navigation map")
    buf.append("")
    buf.append("> **GENERATED FILE — do not hand-edit.** Regenerate with "
               "`python3 project-index.py`. Line numbers reflect the moment of "
               "generation and drift on every `index.html` edit; rerun after editing.")
    buf.append(f">")
    buf.append(f"> Generated: **{now}**")
    buf.append("")

    # quick line-count summary up top
    big = ["index.html", "ttf-relay.py", "ecash_bot.py",
           "vendor/companion/echan.js", "vendor/mediacenter/mediacenter.js"]
    buf.append("## At-a-glance line counts\n")
    for p in big:
        fp = os.path.join(ROOT, p)
        if os.path.exists(fp):
            n = len(read_lines(fp))
            buf.append(f"- {md_anchor(p)} — {n:,} lines")
    buf.append("")

    section_index_html(buf)
    section_python(buf, "ttf-relay.py")
    section_python(buf, "ecash_bot.py")
    section_js_file(buf, "vendor/companion/echan.js")
    section_js_file(buf, "vendor/mediacenter/mediacenter.js")
    section_tree(buf)

    buf.append("---")
    buf.append("_Rebuild: `python3 project-index.py`  ·  Verify freshness: "
               "`python3 project-index.py --check`_")
    return "\n".join(buf) + "\n"


def main():
    args = set(sys.argv[1:])
    report = build_report()
    out_path = os.path.join(ROOT, OUT_NAME)

    if "--stdout" in args:
        sys.stdout.write(report)
        return 0

    if "--check" in args:
        if not os.path.exists(out_path):
            print(f"{OUT_NAME} missing — run: python3 project-index.py", file=sys.stderr)
            return 1
        with open(out_path, "r", encoding="utf-8") as fh:
            current = fh.read()
        # ignore the volatile timestamp line when comparing
        strip = lambda s: re.sub(r"> Generated:.*", "", s)
        if strip(current) != strip(report):
            print(f"{OUT_NAME} is out of date — run: python3 project-index.py", file=sys.stderr)
            return 1
        print(f"{OUT_NAME} is up to date.")
        return 0

    with open(out_path, "w", encoding="utf-8") as fh:
        fh.write(report)
    print(f"Wrote {rel(out_path)} ({len(report):,} bytes).")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
