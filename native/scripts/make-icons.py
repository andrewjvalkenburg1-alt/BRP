#!/usr/bin/env python3
"""Draws the BRP One app icon and launch art in the brand, then writes every size the
iOS and Android projects need. Run: python3 scripts/make-icons.py

Brand: ink #0F0F0F, bone #ECE8DF, Signal Orange #FF5A1F. Display face Big Shoulders Display 800
(falls back to the PWA icon-512 scaled up if the font is missing).
"""
import os, sys
from PIL import Image, ImageDraw, ImageFont

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(HERE, '..'))
INK, BONE, ORANGE = (0x0F, 0x0F, 0x0F), (0xEC, 0xE8, 0xDF), (0xFF, 0x5A, 0x1F)
FONT_PATHS = [os.path.expanduser('~/.fonts/Big_Shoulders_Display_wght_800.ttf'),
              os.path.join(ROOT, 'assets', 'Big_Shoulders_Display_wght_800.ttf')]
PWA_ICON = '/mnt/project-files/barracks/v1/ecosystem/pwa/icons/icon-512.png'


def font(px):
    for p in FONT_PATHS:
        if os.path.exists(p):
            return ImageFont.truetype(p, px)
    return None


def mark(size, bg=INK, scale=1.0):
    """Square art: orange block + BRP in bone, optically centered. scale shrinks the art (for safe zones)."""
    S = 4096  # draw large, then downsample for clean edges
    im = Image.new('RGBA', (S, S), bg + (255,) if bg else (0, 0, 0, 0))
    f = font(int(1180 * scale))
    if f is None:
        src = Image.open(PWA_ICON).convert('RGBA').resize((S, S), Image.LANCZOS)
        return src.resize((size, size), Image.LANCZOS)
    d = ImageDraw.Draw(im)
    text = 'BRP'
    l, t, r, b = d.textbbox((0, 0), text, font=f)
    tw, th = r - l, b - t
    sq = int(th * 0.70)              # block is 70% of the cap height, like the PWA icon
    gap = int(th * 0.30)
    total = sq + gap + tw
    x0 = (S - total) // 2
    ytop = (S - th) // 2
    d.rectangle([x0, ytop + th - sq, x0 + sq, ytop + th], fill=ORANGE)   # sits on the baseline
    d.text((x0 + sq + gap - l, ytop - t), text, font=f, fill=BONE)
    return im.resize((size, size), Image.LANCZOS)


def save(im, path, opaque=True):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    if opaque:
        bg = Image.new('RGB', im.size, INK)
        bg.paste(im, mask=im.split()[3] if im.mode == 'RGBA' else None)
        bg.save(path, optimize=True)
    else:
        im.save(path, optimize=True)
    print('  ' + os.path.relpath(path, ROOT))


def main():
    master = mark(1024)
    save(master, os.path.join(ROOT, 'assets', 'icon-1024.png'))

    # ---- iOS: one 1024 universal icon (Xcode 14+ makes the rest), no alpha ----
    ios_icon = os.path.join(ROOT, 'ios/App/App/Assets.xcassets/AppIcon.appiconset')
    if os.path.isdir(ios_icon):
        save(master, os.path.join(ios_icon, 'AppIcon-512@2x.png'))
        # Launch mark: 200pt square, the art only (the storyboard paints the ink background).
        splash = os.path.join(ROOT, 'ios/App/App/Assets.xcassets/Splash.imageset')
        for f in os.listdir(splash):
            if f.endswith('.png'):
                os.remove(os.path.join(splash, f))
        for n, px in (('1x', 200), ('2x', 400), ('3x', 600)):
            save(mark(px, bg=INK), os.path.join(splash, f'splash@{n}.png'))
        with open(os.path.join(splash, 'Contents.json'), 'w') as fh:
            fh.write('{\n  "images" : [\n'
                     '    { "idiom" : "universal", "filename" : "splash@1x.png", "scale" : "1x" },\n'
                     '    { "idiom" : "universal", "filename" : "splash@2x.png", "scale" : "2x" },\n'
                     '    { "idiom" : "universal", "filename" : "splash@3x.png", "scale" : "3x" }\n'
                     '  ],\n  "info" : { "version" : 1, "author" : "xcode" }\n}\n')

    # ---- Android ----
    res = os.path.join(ROOT, 'android/app/src/main/res')
    if os.path.isdir(res):
        dens = {'mdpi': 1, 'hdpi': 1.5, 'xhdpi': 2, 'xxhdpi': 3, 'xxxhdpi': 4}
        for d, k in dens.items():
            legacy = int(48 * k)
            save(mark(legacy), os.path.join(res, f'mipmap-{d}/ic_launcher.png'))
            rnd = mark(legacy).convert('RGBA')
            m = Image.new('L', rnd.size, 0); ImageDraw.Draw(m).ellipse([0, 0, legacy - 1, legacy - 1], fill=255)
            out = Image.new('RGBA', rnd.size, (0, 0, 0, 0)); out.paste(rnd, mask=m)
            save(out, os.path.join(res, f'mipmap-{d}/ic_launcher_round.png'), opaque=False)
            fg = int(108 * k)  # adaptive foreground: art inside the 66dp safe zone
            save(mark(fg, bg=None, scale=0.58), os.path.join(res, f'mipmap-{d}/ic_launcher_foreground.png'), opaque=False)
        with open(os.path.join(res, 'values/ic_launcher_background.xml'), 'w') as fh:
            fh.write('<?xml version="1.0" encoding="utf-8"?>\n<resources>\n    <color name="ic_launcher_background">#0F0F0F</color>\n</resources>\n')
        # Splash: ink field with the mark centered, every density and orientation Capacitor ships.
        sizes = {'mdpi': (320, 480), 'hdpi': (480, 800), 'xhdpi': (720, 1280), 'xxhdpi': (960, 1600), 'xxxhdpi': (1280, 1920)}
        for d, (w, h) in sizes.items():
            for orient, (W, H) in (('port', (w, h)), ('land', (h, w))):
                canvas = Image.new('RGB', (W, H), INK)
                m = mark(int(min(W, H) * 0.42))
                canvas.paste(m, ((W - m.width) // 2, (H - m.height) // 2))
                save(canvas, os.path.join(res, f'drawable-{orient}-{d}/splash.png'))
        canvas = Image.new('RGB', (480, 320), INK); m = mark(140); canvas.paste(m, ((480 - 140) // 2, (320 - 140) // 2))
        save(canvas, os.path.join(res, 'drawable/splash.png'))


if __name__ == '__main__':
    main()
