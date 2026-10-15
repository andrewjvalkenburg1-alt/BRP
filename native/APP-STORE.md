# BRP One on the App Store: steps for Andrew

Updated Oct 15, 2026. Bundle ID is now **com.dravek.brpone**, because BRP One belongs to the Dravek and Rynoc joint venture and is published under Dravek, Andrew's company. Andrew has an Apple Developer account.

## Fastest path: build in the cloud, no Mac needed

`.github/workflows/ios-testflight.yml` builds, signs and uploads the app to TestFlight on a GitHub macOS runner.

1. In App Store Connect: **Users and Access > Integrations > App Store Connect API**, create a key with the **Admin** role (needed so the build can create the signing certificate). Download the .p8 file once and note the Key ID and Issuer ID.
2. In App Store Connect: **Apps > + > New App**, iOS, name `BRP One`, bundle ID `com.dravek.brpone` (register it first under Certificates, Identifiers & Profiles > Identifiers if it is not offered), SKU `BRPONE-IOS-001`.
3. In GitHub, repo **Settings > Secrets and variables > Actions**, add `APPLE_TEAM_ID`, `ASC_KEY_ID`, `ASC_ISSUER_ID` and `ASC_KEY_P8` (the .p8 file's full text). Never paste these anywhere else.
4. **Actions > iOS TestFlight > Run workflow**, pick `native` (BRP One) or `owner-app` (Dravek HQ, your personal owner app, bundle ID `com.dravek.hq`, created the same way as step 2 with SKU `DRAVEKHQ-IOS-001`; it stays on TestFlight for your own use). The build appears under TestFlight after Apple processes it. Add yourself as an internal tester and install with the TestFlight app.

The Mac steps below still work if you ever want to run the app from Xcode.

## 1. Apple Developer account (you)

Enroll as an **organization** under **Rynoc Solutions**, so the App Store shows "Rynoc Solutions" as the seller instead of your personal name.

1. Get a **D-U-N-S number** for Rynoc Solutions if it does not have one. It is free. Use Apple's lookup tool at developer.apple.com/enroll/duns-lookup first; if no record is found, request one there. Allow a week or more for Dun & Bradstreet to issue it, and the details (legal name, address) must match your state business registration exactly.
2. What Apple checks: Rynoc Solutions must be a legal entity (an LLC or corporation, not a DBA or sole proprietorship name), you must have the authority to sign for it, and it needs a public website on a domain associated with the company. A `github.io` page may not be accepted as the company website; a `rynocsolutions` domain with an email address on that domain is the safer choice.
3. Enroll at developer.apple.com/programs/enroll with your Apple Account (two-factor authentication on). The fee is 99 US dollars a year. Apple may call to verify.
4. Once approved, open App Store Connect (appstoreconnect.apple.com) and accept the agreements under Business. The free app agreement is enough; no banking or tax forms are needed for a free app.

If the D-U-N-S number will take long, you can start TestFlight testing sooner with an individual account, but moving an app from an individual account to an organization later means an app transfer. It is simpler to wait for the organization.

## 2. Prepare the Mac (you)

1. Install **Xcode 26 or later** from the Mac App Store. App Store Connect requires apps built with the iOS 26 SDK. Open it once and let it install its components.
2. Install **Node.js 22 LTS** from nodejs.org (or `brew install node@22`).
3. Get the code and build the web part:

   ```sh
   git clone https://github.com/andrewjvalkenburg1-alt/brp.git
   cd brp/native
   npm ci
   npm run sync
   ```

   `npm run sync` copies the web build from the repo root into `native/www/`, adds the bridge, and copies it into the iOS and Android projects. Run it again every time the web app changes.
4. Open the iOS project:

   ```sh
   open ios/App/App.xcodeproj
   ```

   Open the `.xcodeproj` file (there is no `.xcworkspace` with Swift Package Manager). Xcode downloads the Capacitor packages the first time; wait until "Resolving packages" finishes.

## 3. Signing (you, in Xcode)

1. In the left sidebar, click **App** (the blue project icon), then the **App** target, then **Signing & Capabilities**.
2. Check **Automatically manage signing**. Set **Team** to **Rynoc Solutions**.
3. Confirm **Bundle Identifier** is `com.dravek.brpone`. Xcode registers it in your developer account.
4. Confirm two capabilities are listed: **Push Notifications** and **Background Modes** with **Remote notifications** checked. They come from `App/App.entitlements` and `Info.plist`. If either is missing, click **+ Capability** and add it.
5. Under **General**, set **Version** (1.0) and **Build** (1). Raise the build number for every upload.

## 4. Try it on your iPhone (you)

1. Connect the iPhone with a cable. On the iPhone, turn on **Settings, Privacy & Security, Developer Mode** and restart when asked.
2. In Xcode, pick the iPhone as the run destination at the top and press **Run** (the play button).
3. Walk through the checks in "What only a Mac or iPhone can verify" at the end of this file.

## 5. Archive and upload (you)

1. Set the run destination to **Any iOS Device (arm64)**.
2. **Product, Archive**. When it finishes, the Organizer window opens.
3. Select the archive, click **Distribute App**, choose **App Store Connect**, then **Upload**. Keep the defaults (upload symbols, automatic signing).
4. The build shows in App Store Connect under the app's **TestFlight** tab after processing, usually within an hour. You get an email if something is wrong.

You first need the app record (step 6, item 1) so the upload has somewhere to go.

## 6. App Store Connect listing (you, copy and paste)

1. **Apps, +, New App**: Platform iOS. Name `BRP One`. Primary language English (U.S.). Bundle ID `com.dravek.brpone`. SKU `BRPONE-IOS-001`. User access Full Access.
   If the name is taken, use `BRP One: Barracks Readiness`.

| Field | Text |
|---|---|
| Name (30 max) | BRP One |
| Subtitle (30 max) | Barracks repair tracking |
| Promotional text (170 max) | Report a barracks problem from your phone, scan the room door code, and follow the fix from request to sign-off. Demo app with sample data. |
| Keywords (100 max, commas, no spaces) | barracks,maintenance,work order,repair,housing,soldier,facilities,QR,inspection,dorm,readiness |
| Support URL | https://andrewjvalkenburg1-alt.github.io/BRP/site/ |
| Marketing URL | https://andrewjvalkenburg1-alt.github.io/BRP/site/ |
| Privacy Policy URL | https://andrewjvalkenburg1-alt.github.io/BRP/site/#legal-privacy |
| Category | Primary: Business. Secondary: Productivity |
| Copyright | 2026 Rynoc Solutions |
| Price | Free |

**Description** (4000 max):

```
BRP One shows how the Barracks Readiness Program handles barracks maintenance, from the moment a Soldier reports a problem to the day the fix is signed off. It is a demo. Every building, room, work order and person in it is sample data.

Sign in with one of the demo accounts to see each role:

Soldier: report a problem in your room with a photo, scan the QR code on your door to fill in the room, follow your request, and rate the fix.
Technician and barracks manager: work a queue sorted by the time left on each request, inspect rooms, check room sensors, and use parts from the cabinet.
Site lead, program manager and buyer: run work orders, purchase orders and stock in one place, and search any record by tag.
Garrison commander and COR: read the readiness dashboard and room experience scores by building.

On iPhone and iPad, BRP One also uses:
- The camera to scan room QR codes
- Face ID for quick sign-in (only your demo email is saved on the device)
- Notifications for alerts that tag you, with a tap that opens the record
- The share sheet to send a work order link

BRP One keeps its data on your device. It has no ads and no tracking.

BRP One is built by Rynoc Solutions. It is not an official U.S. Army or Department of Defense app and is not endorsed by either.
```

**Age rating**: answer the questionnaire with None or No for every content question, No for unrestricted web access, No for user-generated content shared with other people, No for messaging or chat with other people, No for gambling and contests, and No for medical or wellness topics. The result should be **4+**.

**App Review Information** (sign-in required: Yes):

- User name: `soldier@brp.demo` Password: `BRPdemo2026!`
- Notes (paste):

```
BRP One is a demo of a barracks maintenance program. All data is sample data and stays on the device. There is no server and no real account creation; these demo accounts are built in.

Demo accounts (password for all: BRPdemo2026!):
- soldier@brp.demo (Soldier portal)
- pm@brp.demo (program manager: back office, ERP, dashboard, satisfaction)

Device features to try:
1. Room QR scan: sign in as soldier@brp.demo. In "Report a maintenance problem", tap "Scan room QR" and scan the attached QR code (room:STW-412-1K). Installation, building and room fill in.
2. Face ID: after signing in with the password, tap Yes on "Use Face ID to sign in". Sign out from the account menu, then tap "Sign in with Face ID".
3. Notifications: allow notifications when the card asks. In the account menu, tap "Test a notification" to see a banner. Tap the banner to return to the app.
4. Share: sign in as pm@brp.demo, open any work order and tap Share.
5. Haptics play on submit, alerts and successful scans.

The app works offline after install.
```

- Attachment: `native/store/review-qr-room-STW-412-1K.png` (the QR code for step 1).
- Contact: your name, phone and email.

Before submitting, check the notes match the wired app: "Scan room QR" (INTEGRATE.md F1), the Face ID offer (H1, H2), and "Test a notification" (H9).

**Version release**: choose **Manually release this version**, so you decide the day it goes live.

## 7. App Privacy "nutrition label" (you)

In App Store Connect, **App Privacy, Get Started**:

1. "Do you or your third-party partners collect data from this app?" **No, we do not collect data from this app.**
2. The label then reads **Data Not Collected**.

Why that is accurate for this build:
- Demo accounts are built into the app. Nobody creates an account and nothing is sent to a server.
- Requests, photos, alerts and settings are kept in the app's local storage on the device. Apple counts data as "collected" only when it leaves the device.
- Face ID never reaches the app; iOS only tells the app yes or no. The bridge saves just the demo email, on the device.
- The app build loads fonts and the animation library from inside the app, so there are no Google Fonts or cdnjs requests.
- No analytics, no ads, no tracking. The privacy manifest (`PrivacyInfo.xcprivacy`) says the same.

Change these answers before you add a push server: sending the device push token, an email address or crash logs to a server is collection, and the label must then list it.

## 8. Screenshots (done, re-run when the app changes)

App Store Connect needs, as of 2026:
- **iPhone 6.9" display**: 1320 x 2868 pixels portrait (1290 x 2796 is also accepted). Required.
- **iPad 13" display**: 2064 x 2752 pixels portrait (2048 x 2732 is also accepted). Required because the app runs on iPad.
- 1 to 10 per size. Smaller iPhone and iPad sizes are scaled from these.

Files in `native/store/screenshots/`, taken from the live app with Chromium at those pixel sizes:

| # | View | iPhone 6.9" | iPad 13" |
|---|---|---|---|
| 1 | Soldier portal | `iphone-6.9/01-soldier-portal.png` | `ipad-13/01-soldier-portal.png` |
| 2 | Field tablet | `iphone-6.9/02-field-tablet.png` | `ipad-13/02-field-tablet.png` |
| 3 | Commander dashboard | `iphone-6.9/03-commander-dashboard.png` | `ipad-13/03-commander-dashboard.png` |
| 4 | ERP | `iphone-6.9/04-erp.png` | `ipad-13/04-erp.png` |
| 5 | Satisfaction | `iphone-6.9/05-satisfaction.png` | `ipad-13/05-satisfaction.png` |

To make them again after the web app changes: `cd native && npm run screenshots`.

The current live footer says "Draft for attorney review". Re-run the screenshots after the legal pages are final so that line is not in the store images.

## 9. TestFlight (you)

**Internal testers** (fastest, no Apple review):
1. App Store Connect, **Users and Access**: add each person (up to 100) with any role.
2. App, **TestFlight, Internal Testing, +**: create a group, add them, add the build.
3. They install the **TestFlight** app and accept the email invite.

**External testers** (people outside your App Store Connect team, up to 10,000):
1. **TestFlight, External Testing, +**: create a group.
2. Fill in **Test Information**: a feedback email, a short beta description, and "What to test" (use the device features list from the review notes).
3. Add the build. The first build of each version goes through **Beta App Review** (often about a day). Give the same demo login as in section 6.
4. Invite by email, or turn on a **public link** to share.

Builds expire after 90 days. Testers send feedback and screenshots from the TestFlight app; you see them under **TestFlight, Feedback**.

## 10. Ratings and reviews: the plan

Ratings come only from real people after the app is released. There is no way to start with ratings, and Apple bans buying reviews, writing fake ones, or giving anything in return for a rating (App Review Guideline 5.6, and the Developer Code of Conduct). Breaking that can get the developer account removed.

The plan:
1. **Before release**: TestFlight with real testers (soldiers, barracks managers, site leads you know). Their feedback goes to you privately through TestFlight. Fix what they report.
2. **After release**: the app asks for a rating with Apple's own prompt (SKStoreReviewController), through `BRPNative.requestReview()`. It is called only after a completed positive action, such as a Soldier giving a fix a thumbs up. The bridge limits it: at least 3 positive actions, at least 2 days after install, and no more than once every 120 days. iOS then decides whether to show it, and shows it at most 3 times a year.
3. Never ask for a rating after an error, on first launch, or in exchange for anything. Reply to reviews in App Store Connect, plainly.

## 11. Submit for review (you)

1. In the app's **1.0** version page: paste the listing, upload the screenshots, pick the build (from TestFlight).
2. **Export compliance** will not be asked: `ITSAppUsesNonExemptEncryption` is set to NO (the app uses only standard HTTPS).
3. **Content rights**: No third-party content needing rights (the fonts are under the SIL Open Font License).
4. **Add for Review**, then **Submit**.

Two review risks to know before you submit:
- **Demo apps (Guideline 2.2)**: Apple's rule is that demos, betas and trial versions belong in TestFlight. BRP One is a complete app that runs on sample data, not a time-limited trial, and the notes say so, but a reviewer may still cite 2.2. If that happens, reply in App Review explaining it is the full program workflow for evaluation and training, with all features working. If Apple still declines, keep it on TestFlight with a public link; that is the path Apple names for demos.
- **Military names**: the app names Army installations. Keep the non-affiliation line in the description and in the app (the website already has a Non-endorsement page), and be ready to say who Rynoc Solutions is.

## 12. Optional: prove it compiles on GitHub (no Mac needed)

`native/.github-workflow-ios.yml.example` builds an unsigned iOS archive on a GitHub macOS runner. It is not active. To use it, copy it to `.github/workflows/ios-build.yml` and run it by hand from the Actions tab. It only runs when started by hand, never on push. It cannot sign or upload; that stays in Xcode.

## 13. Android (later, optional)

The Android project builds a debug APK. For Google Play you would need: a Play Console account (25 US dollars once, organization account needs the same D-U-N-S number), a Firebase project and its `google-services.json` in `native/android/app/` for push (without it, do not call `push.register()` on Android), a signing key, and the Play Data safety form (same answers as section 7). The minimum Android version is 8.0 (API 26), which the barcode scanner requires.

## What only a Mac or iPhone can verify

Checked on Linux: `npx cap sync` succeeds; the Android debug build compiles with all plugins; the web build loads in Chromium at iPhone size with the bridge and every method returns its web fallback with no script errors; the bridge sends the right plugin calls against a simulated Capacitor runtime; the Xcode project file parses; plugin versions match Capacitor 8.

Needs the Mac or an iPhone:
1. The Xcode build itself: Swift Package resolution, compile, and archive (or the GitHub workflow in section 12).
2. Signing, the push entitlement in the provisioning profile, and the upload.
3. The camera permission text, the scanner screen and scanning a printed room QR code.
4. Face ID prompt and text, enable, sign out, unlock, and the Face ID fallback.
5. Notification permission, a real APNs device token from `push.register()`, banners while the app is open, and tap-to-open from a closed app.
6. Haptics, the share sheet, and the rating prompt (in TestFlight the prompt never shows; on a development build it always shows).
7. Status bar color and safe areas on a notched iPhone and on iPad, in portrait and landscape.
8. The launch screen and the app icon on the Home Screen.
9. The app working offline after first launch.
