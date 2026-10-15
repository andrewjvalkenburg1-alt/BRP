#!/usr/bin/env python3
"""Applies the Dravek HQ settings to the generated iOS project. Safe to run more than once.

Run after `npx cap add ios --packagemanager SPM` (already applied to the checked-in project):
    python3 scripts/patch-ios.py

Sets Info.plist (name, Face ID text, export compliance, arm64, light status bar), adds a
privacy manifest (no tracking, no data collected), and draws the icon and launch image
(ink background, bone "D" with a Signal Orange bar).
"""
import glob, os, plistlib, sys
from PIL import Image, ImageDraw, ImageFont

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', 'ios', 'App'))
APP = os.path.join(ROOT, 'App')
PBX = os.path.join(ROOT, 'App.xcodeproj', 'project.pbxproj')
if not os.path.isdir(APP):
    sys.exit('No ios/App/App folder. Run `npx cap add ios --packagemanager SPM` first.')

INK, BONE, SIGNAL = (20, 20, 20), (228, 223, 213), (255, 90, 31)

# ---------- Info.plist ----------
p = os.path.join(APP, 'Info.plist')
info = plistlib.load(open(p, 'rb'))
info['CFBundleDisplayName'] = 'Dravek HQ'
info['NSFaceIDUsageDescription'] = 'Dravek HQ uses Face ID to keep your owner portals locked.'
info['ITSAppUsesNonExemptEncryption'] = False
info['UIRequiredDeviceCapabilities'] = ['arm64']
info['UIStatusBarStyle'] = 'UIStatusBarStyleLightContent'
plistlib.dump(info, open(p, 'wb'), sort_keys=False)

# ---------- privacy manifest ----------
plistlib.dump({
    'NSPrivacyTracking': False,
    'NSPrivacyTrackingDomains': [],
    'NSPrivacyCollectedDataTypes': [],
    'NSPrivacyAccessedAPITypes': [
        {'NSPrivacyAccessedAPIType': 'NSPrivacyAccessedAPICategoryUserDefaults',
         'NSPrivacyAccessedAPITypeReasons': ['CA92.1']},
    ],
}, open(os.path.join(APP, 'PrivacyInfo.xcprivacy'), 'wb'))

pbx = open(PBX, encoding='utf-8').read()
REF, BUILD = 'D7A10E0202F0A0010000BEEF', 'D7A10E0302F0A0010000BEEF'
def once(text, anchor, insert, marker):
    if marker in text:
        return text
    if anchor not in text:
        sys.exit('pbxproj anchor not found: ' + anchor)
    return text.replace(anchor, anchor + insert, 1)
pbx = once(pbx, '/* Begin PBXFileReference section */\n',
           f'\t\t{REF} /* PrivacyInfo.xcprivacy */ = {{isa = PBXFileReference; lastKnownFileType = text.xml; path = PrivacyInfo.xcprivacy; sourceTree = "<group>"; }};\n',
           REF + ' /* PrivacyInfo.xcprivacy */ = ')
pbx = once(pbx, '/* Begin PBXBuildFile section */\n',
           f'\t\t{BUILD} /* PrivacyInfo.xcprivacy in Resources */ = {{isa = PBXBuildFile; fileRef = {REF} /* PrivacyInfo.xcprivacy */; }};\n',
           BUILD + ' /* PrivacyInfo.xcprivacy in Resources */ = ')
pbx = once(pbx, '504EC3131FED79650016851F /* Info.plist */,\n',
           f'\t\t\t\t{REF} /* PrivacyInfo.xcprivacy */,\n', f'{REF} /* PrivacyInfo.xcprivacy */,')
pbx = once(pbx, '504EC3121FED79650016851F /* LaunchScreen.storyboard in Resources */,\n',
           f'\t\t\t\t{BUILD} /* PrivacyInfo.xcprivacy in Resources */,\n', f'{BUILD} /* PrivacyInfo.xcprivacy in Resources */,')
open(PBX, 'w', encoding='utf-8').write(pbx)

# ---------- icon and launch image ----------
FONT = next((f for f in ['/usr/share/fonts/opentype/inter/Inter-ExtraBold.otf',
                         '/usr/share/fonts/opentype/inter/Inter-Bold.otf',
                         '/System/Library/Fonts/Supplemental/Arial Bold.ttf'] if os.path.exists(f)), None)
def mark(size, box):
    im = Image.new('RGB', (size, size), INK)
    d = ImageDraw.Draw(im)
    font = ImageFont.truetype(FONT, int(box * .62)) if FONT else ImageFont.load_default()
    cx = cy = size // 2
    d.text((cx, cy - box * .04), 'D', font=font, fill=BONE, anchor='mm')
    bw, bh = box * .42, box * .05
    d.rectangle([cx - bw / 2, cy + box * .30, cx + bw / 2, cy + box * .30 + bh], fill=SIGNAL)
    return im
mark(1024, 1024).save(os.path.join(APP, 'Assets.xcassets', 'AppIcon.appiconset', 'AppIcon-512@2x.png'))
for f in glob.glob(os.path.join(APP, 'Assets.xcassets', 'Splash.imageset', '*.png')):
    mark(2732, 560).save(f)
print('iOS project patched for Dravek HQ')
