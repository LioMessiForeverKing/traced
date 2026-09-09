#!/usr/bin/env python3
"""Audit comment density and shape against Ayen's rules.

  - explanatory comments <= 5% of non-blank lines, above a small-file floor
  - no inline comments (comment sharing a line with code)
  - no comment block longer than 3 lines

Doc comments (/// and /** */) document an interface rather than explain a body.
Directives (MARK, eslint-disable, shebangs) are navigation and tooling, not prose.
Neither is charged to the budget or held to the block limit; both are reported.
--count-docs restores the old single-bucket behaviour for doc comments.
"""
import sys, os, argparse

C = ('//', [('/*', '*/')])
H = (None, [('<!--', '-->')])
SPEC = {
    '.js': C, '.jsx': C, '.ts': C, '.tsx': C, '.mjs': C, '.cjs': C,
    '.swift': C, '.dart': C, '.c': C, '.h': C, '.cpp': C, '.hpp': C, '.cc': C,
    '.java': C, '.go': C, '.rs': C, '.kt': C, '.scala': C, '.cs': C, '.php': C,
    '.css': (None, [('/*', '*/')]),
    '.scss': C, '.sass': ('//', []), '.less': C, '.styl': C, '.pcss': (None, [('/*', '*/')]),
    '.html': H, '.htm': H, '.xml': H, '.svg': H, '.md': H,
    '.vue': ('//', [('/*', '*/'), ('<!--', '-->')]),
    '.svelte': ('//', [('/*', '*/'), ('<!--', '-->')]),
    '.py': ('#', []), '.sh': ('#', []), '.bash': ('#', []), '.zsh': ('#', []),
    '.rb': ('#', []), '.yml': ('#', []), '.yaml': ('#', []), '.toml': ('#', []),
    '.r': ('#', []), '.sql': ('--', [('/*', '*/')]),
}
DOC_LINE = '///'
DOC_BLOCK = '/**'
DIRECTIVE = ('eslint', 'ts-ignore', 'ts-expect-error', 'prettier', 'swiftlint',
             'pragma', 'noqa', 'type:', 'MARK:', 'shellcheck', 'biome', 'oxlint',
             'stylelint', 'postcss', 'tailwind', 'vitest', 'jest', 'istanbul',
             'swift-tools-version', 'resharper')
SKIP_DIRS = {'node_modules', '.git', '.build', 'build', 'dist', 'out', 'vendor',
             '.next', '.venv', 'venv', '__pycache__', 'Pods', '.svelte-kit',
             'target', 'coverage', '.turbo'}

def classify(path):
    spec = SPEC.get(os.path.splitext(path)[1].lower())
    if not spec:
        return None
    line_tok, blocks = spec
    try:
        src = open(path, encoding='utf-8', errors='replace').read().split('\n')
    except OSError:
        return None

    rows, open_block = [], None
    for raw in src:
        s, i, n = raw, 0, len(raw)
        code = com = ''
        instr = None
        while i < n:
            ch = s[i]
            if open_block is not None:
                end = open_block[1]
                if s.startswith(end, i):
                    com += end; i += len(end); open_block = None; continue
                com += ch; i += 1; continue
            if instr:
                code += ch
                if ch == '\\' and i + 1 < n:
                    code += s[i + 1]; i += 2; continue
                if ch == instr:
                    instr = None
                i += 1; continue
            if ch in '"\'`':
                instr = ch; code += ch; i += 1; continue
            hit = next((b for b in blocks if s.startswith(b[0], i)), None)
            if hit:
                open_block = hit; com += hit[0]; i += len(hit[0]); continue
            # `//` inside a URL is not a comment: http://, file:// and friends.
            if line_tok and s.startswith(line_tok, i) and not (line_tok == '//' and i and s[i - 1] == ':'):
                com += s[i:]; break
            code += ch; i += 1
        rows.append((raw, code.strip(), com.strip()))
    return rows

def is_doc(com, in_block):
    c = com.lstrip()
    if in_block:
        return True, '*/' not in c
    if c.startswith(DOC_BLOCK):
        return True, '*/' not in c[len(DOC_BLOCK):]
    return c.startswith(DOC_LINE), False


def audit(path, max_block, count_docs=False):
    rows = classify(path)
    if rows is None:
        return None
    code_n = com_n = doc_n = directives = 0
    inline, long_blocks = [], []
    run_start = run_len = 0
    in_doc = False
    for idx, (raw, code, com) in enumerate(rows, 1):
        if code:
            code_n += 1
        doc = False
        if com:
            doc, in_doc = is_doc(com, in_doc)
            if count_docs:
                doc = False
            body = com.lstrip('/#*<!- \t')
            is_dir = raw.lstrip().startswith('#!') or any(d.lower() in body.lower() for d in DIRECTIVE)
            if doc:
                doc_n += 1
            elif is_dir:
                directives += 1
                doc = True
            else:
                com_n += 1
                if code:
                    inline.append((idx, raw.strip()[:100]))
        if com and not code and not doc:
            if run_len == 0:
                run_start = idx
            run_len += 1
        else:
            if run_len > max_block:
                long_blocks.append((run_start, run_len))
            run_len = 0
    if run_len > max_block:
        long_blocks.append((run_start, run_len))
    total = code_n + com_n
    return dict(path=path, code=code_n, com=com_n, doc=doc_n,
                pct=(com_n / total * 100) if total else 0.0,
                inline=inline, blocks=long_blocks, directives=directives)

def walk(targets):
    for t in targets:
        if os.path.isfile(t):
            yield t; continue
        for root, dirs, files in os.walk(t):
            dirs[:] = [d for d in dirs if d not in SKIP_DIRS and not d.startswith('.')]
            for f in files:
                yield os.path.join(root, f)

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('paths', nargs='*', default=['.'])
    ap.add_argument('--max-block', type=int, default=3)
    ap.add_argument('--target-pct', type=float, default=5.0)
    ap.add_argument('--floor', type=int, default=3)
    ap.add_argument('--quiet', action='store_true')
    ap.add_argument('--count-docs', action='store_true')
    a = ap.parse_args()

    results = [r for r in (audit(p, a.max_block, a.count_docs) for p in walk(a.paths or ['.'])) if r]
    if not results:
        print('No source files found.'); return 0

    bad = [r for r in results if r['inline'] or r['blocks']
           or (r['pct'] > a.target_pct and r['com'] > a.floor)]
    for r in sorted(results, key=lambda x: -x['pct']):
        fail = r in bad
        if a.quiet and not fail:
            continue
        print(f"{'FAIL' if fail else 'ok  '} {r['pct']:5.1f}%  {r['com']:4d}c/{r['code']:5d}L  {r['path']}")
        for ln, txt in r['inline'][:10]:
            print(f"       inline comment    line {ln}: {txt}")
        if len(r['inline']) > 10:
            print(f"       ... {len(r['inline']) - 10} more inline")
        for st, ln in r['blocks'][:10]:
            print(f"       block of {ln} lines  line {st} (max {a.max_block})")

    tc = sum(r['code'] for r in results); tm = sum(r['com'] for r in results)
    td = sum(r['doc'] for r in results)
    tot = tc + tm
    print(f"\n{'=' * 60}")
    print(f"files {len(results)}   code {tc}   comments {tm}   "
          f"ratio {(tm / tot * 100 if tot else 0):.2f}%  (target <= {a.target_pct}%)")
    if not a.count_docs:
        print(f"doc comments {td}   {(td / (tot + td) * 100 if tot + td else 0):.1f}% of non-blank "
              f"(not charged to the budget; --count-docs to include)")
    print(f"inline {sum(len(r['inline']) for r in results)}   "
          f"blocks>{a.max_block} {sum(len(r['blocks']) for r in results)}   "
          f"directives (not violations) {sum(r['directives'] for r in results)}")
    print(f"files failing: {len(bad)}")
    return 1 if bad else 0

if __name__ == '__main__':
    sys.exit(main())
