#!/usr/bin/env python3
"""Applies the BRP One settings to the generated iOS project. Safe to run more than once.

Run after `npx cap add ios` (it is already applied to the checked-in project):
    python3 scripts/patch-ios.py

It sets:
  - Info.plist: plain usage strings (camera, Face ID), Background Modes remote-notification,
    export compliance flag, arm64, light status bar text on the ink launch.
  - App/App.entitlements with aps-environment (push) and wires it into both build configs.
  - App/PrivacyInfo.xcprivacy (no tracking, no data collected, UserDefaults reason CA92.1).
  - LaunchScreen.storyboard: ink background with the centered mark (image set "Splash").
"""
import os, plistlib, re, sys

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', 'ios', 'App'))
APP = os.path.join(ROOT, 'App')
PBX = os.path.join(ROOT, 'App.xcodeproj', 'project.pbxproj')

if not os.path.isdir(APP):
    sys.exit('No ios/App/App folder. Run `npx cap add ios --packagemanager SPM` first.')

# ---------- Info.plist ----------
info_path = os.path.join(APP, 'Info.plist')
with open(info_path, 'rb') as f:
    info = plistlib.load(f)
info['CFBundleDisplayName'] = 'BRP One'
info['NSCameraUsageDescription'] = 'BRP One uses the camera to scan the QR code on a barracks room door, so your request goes to the right room.'
info['NSFaceIDUsageDescription'] = 'BRP One uses Face ID so you can sign in quickly without typing your password.'
modes = info.get('UIBackgroundModes', [])
if 'remote-notification' not in modes:
    modes.append('remote-notification')
info['UIBackgroundModes'] = modes
info['ITSAppUsesNonExemptEncryption'] = False
info['UIRequiredDeviceCapabilities'] = ['arm64']
info['UIStatusBarStyle'] = 'UIStatusBarStyleLightContent'
with open(info_path, 'wb') as f:
    plistlib.dump(info, f, sort_keys=False)

# ---------- entitlements ----------
ent_path = os.path.join(APP, 'App.entitlements')
with open(ent_path, 'wb') as f:
    # Xcode signs App Store and TestFlight builds with the production APNs environment automatically.
    plistlib.dump({'aps-environment': 'development'}, f)

# ---------- privacy manifest ----------
priv_path = os.path.join(APP, 'PrivacyInfo.xcprivacy')
with open(priv_path, 'wb') as f:
    plistlib.dump({
        'NSPrivacyTracking': False,
        'NSPrivacyTrackingDomains': [],
        'NSPrivacyCollectedDataTypes': [],
        'NSPrivacyAccessedAPITypes': [
            {'NSPrivacyAccessedAPIType': 'NSPrivacyAccessedAPICategoryUserDefaults',
             'NSPrivacyAccessedAPITypeReasons': ['CA92.1']},
        ],
    }, f)

# ---------- project.pbxproj ----------
pbx = open(PBX, encoding='utf-8').read()
ENT_REF, PRIV_REF, PRIV_BUILD = 'B7A10E0102F0A0010000BEEF', 'B7A10E0202F0A0010000BEEF', 'B7A10E0302F0A0010000BEEF'

def once(text, anchor, insert, marker):
    if marker in text:
        return text
    if anchor not in text:
        sys.exit('pbxproj anchor not found: ' + anchor)
    return text.replace(anchor, anchor + insert, 1)

pbx = once(pbx, '/* Begin PBXFileReference section */\n',
           f'\t\t{ENT_REF} /* App.entitlements */ = {{isa = PBXFileReference; lastKnownFileType = text.plist.entitlements; path = App.entitlements; sourceTree = "<group>"; }};\n'
           f'\t\t{PRIV_REF} /* PrivacyInfo.xcprivacy */ = {{isa = PBXFileReference; lastKnownFileType = text.xml; path = PrivacyInfo.xcprivacy; sourceTree = "<group>"; }};\n',
           ENT_REF + ' /* App.entitlements */ = ')
pbx = once(pbx, '/* Begin PBXBuildFile section */\n',
           f'\t\t{PRIV_BUILD} /* PrivacyInfo.xcprivacy in Resources */ = {{isa = PBXBuildFile; fileRef = {PRIV_REF} /* PrivacyInfo.xcprivacy */; }};\n',
           PRIV_BUILD + ' /* PrivacyInfo.xcprivacy in Resources */ = ')
# group children
pbx = once(pbx, '504EC3131FED79650016851F /* Info.plist */,\n',
           f'\t\t\t\t{ENT_REF} /* App.entitlements */,\n\t\t\t\t{PRIV_REF} /* PrivacyInfo.xcprivacy */,\n',
           f'{ENT_REF} /* App.entitlements */,')
# resources phase
pbx = once(pbx, '504EC3121FED79650016851F /* LaunchScreen.storyboard in Resources */,\n',
           f'\t\t\t\t{PRIV_BUILD} /* PrivacyInfo.xcprivacy in Resources */,\n',
           f'{PRIV_BUILD} /* PrivacyInfo.xcprivacy in Resources */,')
# entitlements build setting on the App target configs (the ones with INFOPLIST_FILE)
def add_ent(m):
    block = m.group(0)
    if 'CODE_SIGN_ENTITLEMENTS' in block:
        return block
    return block.replace('CODE_SIGN_STYLE = Automatic;', 'CODE_SIGN_ENTITLEMENTS = App/App.entitlements;\n\t\t\t\tCODE_SIGN_STYLE = Automatic;', 1)
pbx = re.sub(r'buildSettings = \{[^{}]*INFOPLIST_FILE = App/Info.plist;[^{}]*\}', add_ent, pbx)
open(PBX, 'w', encoding='utf-8').write(pbx)

# ---------- launch screen: ink background, centered mark ----------
LAUNCH = '''<?xml version="1.0" encoding="UTF-8"?>
<document type="com.apple.InterfaceBuilder3.CocoaTouch.Storyboard.XIB" version="3.0" toolsVersion="22505" targetRuntime="iOS.CocoaTouch" propertyAccessControl="none" useAutolayout="YES" launchScreen="YES" useTraitCollections="YES" useSafeAreas="YES" colorMatched="YES" initialViewController="01J-lp-oVM">
    <device id="retina6_12" orientation="portrait" appearance="dark"/>
    <dependencies>
        <deployment identifier="iOS"/>
        <plugIn identifier="com.apple.InterfaceBuilder.IBCocoaTouchPlugin" version="22504"/>
        <capability name="Safe area layout guides" minToolsVersion="9.0"/>
        <capability name="documents saved in the Xcode 8 format" minToolsVersion="8.0"/>
    </dependencies>
    <scenes>
        <!--Launch Screen: ink background, BRP One mark centered-->
        <scene sceneID="EHf-IW-A2E">
            <objects>
                <viewController id="01J-lp-oVM" sceneMemberID="viewController">
                    <view key="view" contentMode="scaleToFill" id="Ze5-6b-2t3">
                        <rect key="frame" x="0.0" y="0.0" width="393" height="852"/>
                        <autoresizingMask key="autoresizingMask" widthSizable="YES" heightSizable="YES"/>
                        <subviews>
                            <imageView clipsSubviews="YES" userInteractionEnabled="NO" contentMode="scaleAspectFit" horizontalHuggingPriority="251" verticalHuggingPriority="251" image="Splash" translatesAutoresizingMaskIntoConstraints="NO" id="snD-IY-ifK">
                                <rect key="frame" x="96.666666666666671" y="326" width="200" height="200"/>
                                <constraints>
                                    <constraint firstAttribute="width" constant="200" id="w1B-rp-001"/>
                                    <constraint firstAttribute="height" constant="200" id="h1B-rp-001"/>
                                </constraints>
                            </imageView>
                        </subviews>
                        <viewLayoutGuide key="safeArea" id="Bcu-3y-fUS"/>
                        <color key="backgroundColor" red="0.058823529411764705" green="0.058823529411764705" blue="0.058823529411764705" alpha="1" colorSpace="custom" customColorSpace="sRGB"/>
                        <constraints>
                            <constraint firstItem="snD-IY-ifK" firstAttribute="centerX" secondItem="Ze5-6b-2t3" secondAttribute="centerX" id="cx1-rp-001"/>
                            <constraint firstItem="snD-IY-ifK" firstAttribute="centerY" secondItem="Ze5-6b-2t3" secondAttribute="centerY" id="cy1-rp-001"/>
                        </constraints>
                    </view>
                </viewController>
                <placeholder placeholderIdentifier="IBFirstResponder" id="iYj-Kq-Ea1" userLabel="First Responder" sceneMemberID="firstResponder"/>
            </objects>
            <point key="canvasLocation" x="53" y="375"/>
        </scene>
    </scenes>
    <resources>
        <image name="Splash" width="200" height="200"/>
    </resources>
</document>
'''
open(os.path.join(APP, 'Base.lproj', 'LaunchScreen.storyboard'), 'w', encoding='utf-8').write(LAUNCH)
print('iOS project patched: Info.plist, App.entitlements, PrivacyInfo.xcprivacy, project.pbxproj, LaunchScreen.storyboard')
