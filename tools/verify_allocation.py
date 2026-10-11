#!/usr/bin/env python3
"""Re-derive every pilot draw in Python and compare with what the app recorded.

Usage:  python3 tools/verify_allocation.py pilot-log-….csv [pilot-….csv]

The log ("دفتر آزمایش CSV") holds, for each draw, the seed and the full eligible list
(key|stratum). From that alone this script rebuilds the allocation with the same algorithm as
the app (documented at the top of the PILOT-CORE block in docs/index.html):
mulberry32(seed) -> Fisher-Yates on the key-sorted eligible list -> first `batch` picked ->
in each stratum the first half "message", second half "control", an odd last one by rng() < 0.5.
It checks the input hash, the picked list and the arms, and (if given) every row of the pilot CSV.
Exit code 0 = 100% identical.
"""
import csv
import json
import re
import sys

STRATA = ['v1_d45', 'v1_d60', 'v2_d45', 'v2_d60']
M32 = 0xFFFFFFFF


def imul(a, b):
    return (a * b) & M32


def mulberry32(seed):
    state = [seed & M32]

    def rng():
        a = (state[0] + 0x6D2B79F5) & M32
        state[0] = a
        t = imul(a ^ (a >> 15), 1 | a)
        t = ((t + imul(t ^ (t >> 7), 61 | t)) & M32) ^ t
        return ((t ^ (t >> 14)) & M32) / 4294967296
    return rng


def utf16_units(s):
    b = s.encode('utf-16-le')
    return [b[i] | (b[i + 1] << 8) for i in range(0, len(b), 2)]


def fnv1a(s):
    h = 0x811c9dc5
    for u in utf16_units(s):
        h = imul(h ^ u, 16777619)
    return '%08x' % h


def draw_batch(eligible, seed, n):
    lst = sorted(eligible, key=lambda x: utf16_units(x['key']))
    rng = mulberry32(seed)
    for i in range(len(lst) - 1, 0, -1):
        j = int(rng() * (i + 1))
        lst[i], lst[j] = lst[j], lst[i]
    out = [{'key': x['key'], 'stratum': x['stratum'], 'arm': ''} for x in lst[:max(0, min(n, len(lst)))]]
    for s in STRATA:
        g = [x for x in out if x['stratum'] == s]
        h = len(g) // 2
        for i, x in enumerate(g):
            x['arm'] = 'message' if i < h else 'control'
        if len(g) % 2:
            g[-1]['arm'] = 'message' if rng() < 0.5 else 'control'
    return out


FA = '۰۱۲۳۴۵۶۷۸۹'
AR = '٠١٢٣٤٥٦٧٨٩'


def norm_name(s):
    s = ''.join(str(FA.index(c)) if c in FA else str(AR.index(c)) if c in AR else c for c in s)
    s = re.sub('[يى]', 'ی', s).replace('ك', 'ک').replace('ة', 'ه')
    s = re.sub('[ً-ٰٟـ]', '', s)
    s = re.sub('[‌‍‎‏ ]', ' ', s)
    return re.sub(r'\s+', ' ', s).strip().lower()


def read_csv(path):
    with open(path, encoding='utf-8-sig', newline='') as f:
        return list(csv.DictReader(f))


def main(argv):
    if len(argv) < 2:
        print(__doc__)
        return 2
    draws = [json.loads(r['detail']) for r in read_csv(argv[1]) if r['event'] == 'draw']
    bad = 0
    expected = {}
    for d in draws:
        mine = draw_batch(d['eligible'], int(d['seed']), int(d['batch']))
        h = fnv1a('\n'.join(x['key'] + '|' + x['stratum'] for x in d['eligible']))
        ok_hash = h == d['inputHash']
        ok_pick = mine == d['picked']
        bad += (not ok_hash) + (not ok_pick)
        print(f"{d['date']}  seed {d['seed']}  eligible {len(d['eligible'])}  picked {len(mine)}  "
              f"hash {'OK' if ok_hash else 'MISMATCH'}  allocation {'OK' if ok_pick else 'MISMATCH'}")
        for x in mine:
            expected[(d['date'], x['key'])] = (x['stratum'], x['arm'], str(d['seed']))
    if len(argv) > 2:
        rows = read_csv(argv[2])
        seen = 0
        for r in rows:
            k = (r['batch_date'], norm_name(r['name']))
            want = expected.get(k)
            got = (r['stratum'], r['arm'], r['seed'])
            if want != got:
                bad += 1
                print(f"row mismatch: {r['name']} {r['batch_date']}: export {got} vs recomputed {want}")
            seen += 1
        if seen != len(expected):
            bad += 1
            print(f'export has {seen} rows, recomputed {len(expected)}')
        else:
            print(f'pilot CSV: {seen} rows match')
    print('100% identical' if not bad else f'{bad} problem(s)')
    return 0 if not bad else 1


if __name__ == '__main__':
    sys.exit(main(sys.argv))
