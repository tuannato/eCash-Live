"""Does every neo language-pack key still resolve against index.html?

neo's packs are VALUE-keyed: `domMap` maps a CSS selector to {EN text: translated},
`titleMap` maps an EN title= string to its translation, and `dom` maps a selector
to replacement text. Nothing is keyed by an identifier, so nothing can be checked
the way Flow's `data-i18n` keys are — and when someone rewords a label in the
markup, the entry stops matching and that element silently stays English in all
15 languages. No error, no console warning, no failing test.

This resolves each key back against index.html. It cannot verify a translation is
GOOD; it verifies the thing being translated still exists.

Titles are searched across the WHOLE file, not just title="..." attributes,
because several are assigned from JavaScript at runtime.
"""
import glob
import json
import os
import re
import sys

HTML = "index.html"


def selector_present(html, sel):
    """Does anything still CREATE an element this selector could match?

    Creation, not reference. Half of neo's UI is built at runtime, so a static
    scan of class="..." alone reports live elements as missing — .watchlist-
    empty-state exists only as `empty.className = '...'`. But the opposite trap
    is worse: #tip-btn appears in a leftover getElementById() call for a button
    deleted in v1.7.2, and treating any mention as proof would hide exactly the
    drift this check exists to find. So: markup attributes, or an assignment
    that puts the name on an element.

    Deliberately loose beyond that. A false PASS costs one missed rename; a
    false FAIL trains people to ignore the check, which costs all of them."""
    for part in re.split(r"[\s,>+~]+", sel.strip()):
        part = part.strip()
        if not part:
            continue
        m = re.match(r"^#([A-Za-z0-9_-]+)", part)
        if m:
            n = re.escape(m.group(1))
            if re.search(r'id="' + n + r'"', html):
                return True
            if re.search(r"""\.id\s*=\s*['"]""" + n + r"""['"]""", html):
                return True
            continue
        m = re.match(r"^\.([A-Za-z0-9_-]+)", part)
        if m:
            n = re.escape(m.group(1))
            if re.search(r'class="[^"]*\b' + n + r'\b', html):
                return True
            # built at runtime: className = 'x' / classList.add('x')
            if re.search(r"""className\s*=\s*['"][^'"]*\b""" + n + r"""\b""", html):
                return True
            if re.search(r"""classList\.add\([^)]*['"]""" + n + r"""['"]""", html):
                return True
            continue
        m = re.match(r"^([a-z]+[0-9]?)$", part)
        if m and re.search(r"<" + m.group(1) + r"[\s>]", html):
            return True
    return False


def main():
    if not os.path.exists(HTML):
        print(f"::error::{HTML} not found")
        return 1
    html = open(HTML, encoding="utf-8").read()
    # flow.*.json are Flow's key-value packs and topics.*.json is neo's
    # Topics overlay in the same shape -- neither carries a dom/domMap, so
    # both contribute zero checks here while still being counted. Left in,
    # this line reported "30 packs" for the 15 it actually inspects: a
    # doubled coverage figure in the CI log, which is the kind of number
    # nobody re-derives. tools/test-neo-topics-i18n.mjs covers topics.*.
    packs = sorted(p for p in glob.glob("vendor/i18n/*.json")
                   if "/flow." not in p and "/topics." not in p)
    if not packs:
        print("::error::no neo language packs found")
        return 1

    bad = 0
    checked = 0
    for path in packs:
        pack = json.load(open(path, encoding="utf-8"))
        problems = []

        for sel in (pack.get("dom") or {}):
            checked += 1
            if not selector_present(html, sel):
                problems.append(f"dom selector no longer in {HTML}: {sel}")

        for sel, mapping in (pack.get("domMap") or {}).items():
            checked += 1
            if not selector_present(html, sel):
                problems.append(f"domMap selector no longer in {HTML}: {sel}")
                continue
            for en in mapping:
                checked += 1
                if en not in html:
                    problems.append(f"domMap[{sel}] source text gone: {en[:60]!r}")

        for en in (pack.get("titleMap") or {}):
            checked += 1
            if en not in html:
                problems.append(f"titleMap source text gone: {en[:60]!r}")

        if problems:
            bad = 1
            print(f"::error file={path}::{len(problems)} key(s) no longer resolve")
            for p in problems[:8]:
                print(f"   {p}")
            if len(problems) > 8:
                print(f"   … and {len(problems) - 8} more")

    print(f"neo i18n: {checked} keys resolved across {len(packs)} packs")
    if bad:
        print("A key that no longer resolves means that element silently stays "
              "English in every language. Re-point the pack entry, or remove it.")
    return bad


if __name__ == "__main__":
    sys.exit(main())
