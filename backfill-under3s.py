#!/usr/bin/env python3
"""Add pct_under_3s to daily rollup rows written before the relay recorded it.

WHY THIS IS NOT PART OF THE RELAY
    write_day() only ever rolls FORWARD and never rewrites a day. That is
    deliberate: ttf-daily.jsonl is the one dataset here that cannot be
    reconstructed, and a service that silently rewrites its own history is a
    service you cannot cite. So this is a separate, manual, dry-run-by-default
    tool — an operator decision, not a background behaviour.

WHAT MAKES IT SAFE
    It does not trust itself. For every day it recomputes the WHOLE row from
    ttf.log and compares each existing field against the stored value. Only if
    every one matches exactly does it add pct_under_3s to that row.

    That comparison is the entire point. If the recomputation reproduces
    samples, tps, mean, p10/p50/p90, min and max exactly, then it is reading
    the same set of samples the original row was built from — so the share it
    derives from those samples belongs to that row. If ANY field differs, the
    audit log no longer holds that whole day (rotation, truncation, downtime)
    and the day is refused. A mismatch is not a rounding quibble to be waved
    through; it means the inputs are not the same inputs.

    It also reuses the relay's OWN parse_audit_for_day() and summarize() by
    importing them, rather than reimplementing the maths. A second
    implementation that merely looked equivalent would be comparing two
    guesses.

USAGE
    python3 backfill-under3s.py                 # dry run: report only
    python3 backfill-under3s.py --write         # apply (takes a backup first)
    python3 backfill-under3s.py --days 30       # widen the window (audit is ~14d)

EXIT CODES
    0 nothing to do, or applied cleanly     1 refused / error
"""
import argparse
import json
import os
import shutil
import sys
import types
from datetime import date, datetime, timedelta, timezone

# ---------------------------------------------------------------- import relay
# The relay imports websockets at module scope; none of the rollup maths needs
# it. Stub only enough for the import, and never start any of its tasks.
for name, attrs in (("websockets", {}),
                    ("websockets.datastructures", {"Headers": dict}),
                    ("websockets.http11", {"Response": object})):
    if name not in sys.modules:
        m = types.ModuleType(name)
        for k, v in attrs.items():
            setattr(m, k, v)
        sys.modules[name] = m
sys.modules["websockets"].datastructures = sys.modules["websockets.datastructures"]
sys.modules["websockets"].http11 = sys.modules["websockets.http11"]

import importlib.util
_here = os.path.dirname(os.path.abspath(__file__))
_spec = importlib.util.spec_from_file_location("ttf_relay", os.path.join(_here, "ttf-relay.py"))
relay = importlib.util.module_from_spec(_spec)
sys.modules["ttf_relay"] = relay
_spec.loader.exec_module(relay)

DAILY_PATH = getattr(relay, "TTF_DAILY_LOG_PATH", None)

# Fields present in a stored row that we can independently recompute. `date` is
# the key, not a measurement; pct_under_3s is what we are adding.
CHECKED = ("samples", "tps", "ttf_mean_ms", "ttf_p10_ms", "ttf_p50_ms",
           "ttf_p90_ms", "ttf_min_ms", "ttf_max_ms", "coverage_sec")


def find_daily_path():
    if DAILY_PATH:
        return str(DAILY_PATH)
    for attr in dir(relay):
        if "DAILY" in attr.upper():
            v = getattr(relay, attr)
            if isinstance(v, (str, os.PathLike)) and str(v).endswith(".jsonl"):
                return str(v)
    return None


def compare(stored, fresh):
    """Return a list of (field, stored, recomputed) for every field that differs.

    Exact equality on purpose. These are integers and a 5-decimal rounded float
    produced by the same function from the same inputs — if they are not equal,
    the inputs were not the same, and "close enough" would be exactly the
    hand-wave this tool exists to avoid.
    """
    diffs = []
    for f in CHECKED:
        if f not in stored or f not in fresh:
            continue                      # older rows lack coverage_sec
        if stored[f] != fresh[f]:
            diffs.append((f, stored[f], fresh[f]))
    return diffs


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--write", action="store_true",
                    help="apply the change (default is a dry run)")
    ap.add_argument("--days", type=int, default=20,
                    help="how far back to look (default 20; audit retention is ~14d)")
    ap.add_argument("--path", default=None, help="override ttf-daily.jsonl path")
    args = ap.parse_args()

    path = args.path or find_daily_path()
    if not path or not os.path.exists(path):
        print(f"error: rollup file not found ({path})", file=sys.stderr)
        return 1
    print(f"rollup : {path}")
    print(f"audit  : {relay.TTF_LOG_PATH}")
    print(f"window : last {args.days} days")
    print(f"mode   : {'WRITE' if args.write else 'dry run (nothing will be changed)'}\n")

    raw = open(path, encoding="utf-8").read().split("\n")
    rows = []
    for i, line in enumerate(raw):
        t = line.strip()
        if not t:
            continue
        try:
            rows.append((i, json.loads(t)))
        except Exception:
            print(f"  line {i+1}: unparseable, left untouched")

    today = datetime.now(timezone.utc).date()
    floor = today - timedelta(days=args.days)

    updated, refused, skipped, nodata = 0, 0, 0, 0
    changes = {}

    for idx, row in rows:
        ds = row.get("date")
        if not isinstance(ds, str):
            continue
        try:
            d = date.fromisoformat(ds)
        except ValueError:
            continue
        if d < floor or d >= today:
            continue
        if "pct_under_3s" in row:
            skipped += 1
            continue

        samples, first_ts, last_ts = relay.parse_audit_for_day(d)
        fresh = relay.summarize(samples, first_ts, last_ts) if samples else None
        if not fresh:
            print(f"  {ds}  no audit data — the log no longer covers this day. left as is.")
            nodata += 1
            continue

        diffs = compare(row, fresh)
        if diffs:
            refused += 1
            print(f"  {ds}  REFUSED — recomputation does not match the stored row:")
            for f, a, b in diffs:
                print(f"             {f:15} stored={a!r}  recomputed={b!r}")
            print(f"             the audit log does not hold the same samples "
                  f"this row was built from; pct_under_3s from it would not "
                  f"belong to this row.")
            continue

        new = dict(row)
        # Insert next to the other percentile fields rather than at the end, so
        # a human reading the file sees it where write_day() now puts it.
        rebuilt = {}
        for k, v in new.items():
            rebuilt[k] = v
            if k == "ttf_p90_ms":
                rebuilt["pct_under_3s"] = fresh["pct_under_3s"]
        if "pct_under_3s" not in rebuilt:
            rebuilt["pct_under_3s"] = fresh["pct_under_3s"]
        changes[idx] = rebuilt
        updated += 1
        print(f"  {ds}  verified ({len(samples):,} samples, all {len(CHECKED)} fields match)"
              f"  ->  pct_under_3s = {fresh['pct_under_3s']}")

    print(f"\n  {updated} to update · {refused} refused · {skipped} already had it · "
          f"{nodata} not in the audit log")

    if not changes:
        print("\nnothing to do.")
        return 0
    if not args.write:
        print("\ndry run — nothing written. re-run with --write to apply.")
        return 0

    backup = f"{path}.bak.{datetime.now(timezone.utc):%Y%m%dT%H%M%SZ}"
    shutil.copy2(path, backup)
    print(f"\nbackup : {backup}")

    out = list(raw)
    for idx, obj in changes.items():
        out[idx] = json.dumps(obj, separators=(",", ":"))

    # Write via a temp file in the same directory, then rename: a crash
    # mid-write must not be able to leave a half-written rollup behind.
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        f.write("\n".join(out))
    os.replace(tmp, path)

    # Read it back and prove the file still parses and nothing else moved.
    after = [json.loads(l) for l in open(path, encoding="utf-8").read().split("\n") if l.strip()]
    before = [r for _, r in rows]
    if len(after) != len(before):
        print(f"error: row count changed {len(before)} -> {len(after)}; restore {backup}",
              file=sys.stderr)
        return 1
    for b, a in zip(before, after):
        extra = set(a) - set(b)
        if extra - {"pct_under_3s"} or set(b) - set(a):
            print(f"error: fields changed on {b.get('date')}; restore {backup}", file=sys.stderr)
            return 1
        for k in b:
            if b[k] != a[k]:
                print(f"error: {k} changed on {b.get('date')}; restore {backup}", file=sys.stderr)
                return 1
    print(f"written. {updated} rows gained pct_under_3s; every other field verified unchanged.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
