"""Chrome 'view-source' saves -> raw HTML. Usage: python3 tools/unwrap-fixtures.py"""
import re, html, glob, os
for f in glob.glob('fixtures/*.html'):
    s = open(f, encoding='utf-8', errors='replace').read()
    rows = re.findall(r'<td class="line-content">(.*?)</td></tr>', s, flags=re.S)
    out = []
    for r in rows:
        r = r.replace('<br>', '')
        r = re.sub(r'<[^>]+>', '', r)
        out.append(html.unescape(r))
    open('fixtures/raw/' + os.path.basename(f), 'w', encoding='utf-8').write('\n'.join(out))
    print(f, len(out), 'lines')
