#!/usr/bin/env python3
"""Downloads the web fonts and GSAP the web build loads from Google Fonts and cdnjs into native/vendor/,
so the app works offline and makes no third-party requests. copy-web.mjs then points index.html at them.
Run once (the files are kept in the repo): python3 scripts/vendor-assets.py
"""
import os, re, urllib.request

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..'))
OUT = os.path.join(ROOT, 'vendor')
FONTS_CSS = 'https://fonts.googleapis.com/css2?family=Big+Shoulders+Display:wght@800&family=Archivo:wght@400;600&family=Archivo+Narrow:wght@600&display=swap'
GSAP = 'https://cdnjs.cloudflare.com/ajax/libs/gsap/3.15.0/gsap.min.js'
UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36'


def get(url):
    req = urllib.request.Request(url, headers={'User-Agent': UA})
    with urllib.request.urlopen(req, timeout=60) as r:
        return r.read()


os.makedirs(os.path.join(OUT, 'fonts'), exist_ok=True)
css = get(FONTS_CSS).decode()
n = 0
def local(m):
    global n
    url = m.group(1)
    name = re.sub(r'[^A-Za-z0-9._-]', '_', url.split('/')[-1])
    path = os.path.join(OUT, 'fonts', name)
    if not os.path.exists(path):
        open(path, 'wb').write(get(url))
    n += 1
    return 'url(fonts/' + name + ')'
css = re.sub(r'url\((https://fonts\.gstatic\.com/[^)]+)\)', local, css)
open(os.path.join(OUT, 'fonts.css'), 'w').write('/* Google Fonts (SIL Open Font License), saved for offline use in the BRP One app */\n' + css)
open(os.path.join(OUT, 'gsap.min.js'), 'wb').write(get(GSAP))
print(f'vendor/: fonts.css with {n} font files, gsap.min.js')
