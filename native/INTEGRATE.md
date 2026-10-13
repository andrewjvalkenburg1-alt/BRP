# BRP One native hooks

Status Oct 13, 2026, bridge v1.0. This is the list of small changes the BRP One shell needs so the iOS and Android app uses real device features. Each hook is guarded, so the same build keeps working on the web exactly as it does today.

The bridge is one file: `native/www-bridge/brp-native.js`. It defines `window.BRPNative`.

## 0. How the bridge gets into the page

- **In the app:** `npm run sync` (in `native/`) copies the web build into `native/www/` and adds two script tags after the viewport meta: `capacitor.js` (the Capacitor runtime) and `brp-native.js`. Nothing in the app source has to change for this.
- **On the web (optional, recommended):** copy `brp-native.js` next to `index.html` in the published build and add `<script src="brp-native.js"></script>` after the viewport meta. On the web every method returns its fallback, so this changes nothing for web users. It keeps one copy of the bridge in both builds. The copy script sees the tag and does not add a second one.
- **Inside the shell's frames** (Soldier portal and back office, field tablet, dashboard): the frames are same-origin `srcdoc` frames, so frame code uses `var N = window.BRPNative || parent.BRPNative;`.

Every hook below starts with `window.BRPNative && BRPNative.isNative()` (or `N && N.isNative()` in a frame). On the web that is false and the existing code runs.

## 1. The bridge API

| Call | Returns in the app | Returns on the web |
|---|---|---|
| `isNative()` | `true` | `false` |
| `platform()` | `'ios'` or `'android'` | `'web'` |
| `info()` | `{ version, native, platform, plugins }` (which plugins are present) | same shape, all false |
| `scanQR({ prompt? })` | text of the scanned QR code, or `null` if cancelled | `null` |
| `parseRoom(text)` | pure helper, works everywhere: `{ id:'STW-412-1K', inst, bldg, room, tag:'room:STW-412-1K', raw }` or `null` | same |
| `biometric.isAvailable()` | `true` when Face ID or Touch ID is set up | `false` |
| `biometric.label()` | `'Face ID'`, `'Touch ID'`, `'Fingerprint'` ... or `null` | `null` |
| `biometric.enrolledEmail()` | the saved demo email, or `null` (no prompt) | `null` |
| `biometric.enable(email)` | prompts Face ID, then saves the email; `true` when saved | `false` |
| `biometric.unlock()` | prompts Face ID; the saved email on success, else `null` | `null` |
| `biometric.disable()` | forgets the email; `true` | `false` |
| `push.register()` | asks permission, registers with APNs (iOS) or FCM (Android), returns the device token or `null` | `null` |
| `push.token()` | last token this session, or `null` | `null` |
| `notify({ title, body, ref })` | shows a real banner now (local notification); `true` when scheduled | `false` |
| `notifyPermission()` | `'granted'`, `'denied'` or `'prompt'` (no prompt shown) | `null` |
| `onOpen(fn)` | `fn(ref, source)` runs when someone taps a push or local banner, or opens a `?ref=` link. `source` is `'push'`, `'local'` or `'link'`. A tap that launched the app is held until `onOpen` is set. Returns an unsubscribe function. | same, never fires |
| `haptic(kind)` | `kind`: `'light'`, `'medium'`, `'heavy'`, `'success'`, `'warning'`, `'error'`, `'select'`; `true` | `false` |
| `share({ title, text, url })` | opens the share sheet; `true` when shared | `false` |
| `shareWorkOrder('WO-24366' or { id, title, place })` | share sheet with the work order link; `true` | `false` |
| `workOrderLink(id)` | pure: `https://andrewjvalkenburg1-alt.github.io/BRP/?ref=wo%3AWO-24366` | same |
| `statusBar('dark' or 'light')` | sets status bar text for an ink (`'dark'`) or bone (`'light'`) background; `true` | `false` |
| `requestReview()` | counts one positive action and asks iOS for the rating prompt only when the limits allow (below); `true` when iOS was asked | `false` |

Events on `window`: `brp-native-push` (a push arrived while the app was open; `detail: { title, body, ref, data }`) and `brp-native-push-token` (`detail: { token }`).

What is stored: only the demo account email for quick sign-in (Preferences key `brp.bio.email`), the first run time, and the review counters. No passwords anywhere.

At start-up in the app the bridge also: adds `brp-native` and `brp-ios` (or `brp-android`) classes to `<html>`, defines `--brp-safe-top/right/bottom/left` CSS variables (from `env(safe-area-inset-*)`), sets the status bar to light text on ink, sends the Android back button to `history.back()`, and wires the tap listeners early.

## 2. Hooks for the shell (`brp-one.html`, the host script)

Line numbers are from the Oct 13 build and will move. Search for the function name.

### H1. After sign-in, offer Face ID (in `signIn(a, fresh)`)

Add after `if (fresh) toast('Signed in as ' + ...)`:

```js
if (fresh && window.BRPNative && BRPNative.isNative()) setTimeout(function () { offerBio(); }, 1400);
```

and this function next to `signIn`:

```js
function offerBio() {
  if (!U) return;
  BRPNative.biometric.enrolledEmail().then(function (saved) {
    if (saved === U.email) return null;
    return BRPNative.biometric.label();
  }).then(function (name) {
    if (!name || !U) return;
    if (!confirm('Use ' + name + ' to sign in as ' + U.email + ' next time? BRP One saves only your email on this device.')) return;
    BRPNative.biometric.enable(U.email).then(function (ok) { toast(ok ? name + ' sign-in is on for this device.' : name + ' did not confirm. You can turn it on next time you sign in.'); });
  });
}
```

Show it after the notification card (H6) is answered if both would appear at once. `confirm()` works in the app (Capacitor shows a native alert). Swap it for the shell's own card later if you prefer the look.

### H2. "Sign in with Face ID" on the sign-in screen (in the gate script)

Call `bioButton()` at the end of the gate set-up and inside `gateStart()`:

```js
function bioButton() {
  if (!window.BRPNative || !BRPNative.isNative()) return;
  Promise.all([BRPNative.biometric.enrolledEmail(), BRPNative.biometric.label()]).then(function (r) {
    var email = r[0], name = r[1], old = document.getElementById('bg-bio');
    if (!email || !name) { if (old) old.remove(); return; }
    var b = old || document.createElement('button');
    b.id = 'bg-bio'; b.type = 'button'; b.className = 'btn'; b.textContent = 'Sign in with ' + name;
    if (!old) $('#bg-submit').insertAdjacentElement('afterend', b);
    b.onclick = function () {
      BRPNative.biometric.unlock().then(function (e) {
        var a = e && findAcct(e);
        if (a) { form.reset(); status.textContent = ''; signIn(a, true); }
        else status.textContent = name + ' did not confirm. Sign in with your password.';
      });
    };
  });
}
```

Optional: call `b.onclick()` once on app open so Face ID comes up by itself.

In the account menu, add "Turn off Face ID sign-in" that calls `BRPNative.biometric.disable()` (show it only when `enrolledEmail()` matches `U.email`).

### H3. Notification taps and shared links open the record (once, at load)

After `navigate(tag)` is defined:

```js
var pendingRef = (function () { try { return new URLSearchParams(location.search).get('ref') || ''; } catch (e) { return ''; } })();
if (window.BRPNative) BRPNative.onOpen(function (ref) {
  if (!U) { pendingRef = ref; return; }
  var r = navigate(ref); if (r !== true) toast(r);
});
```

In `signIn`, after `route();`:

```js
if (pendingRef) { var pr = pendingRef; pendingRef = ''; setTimeout(function () { var r = navigate(pr); if (r !== true) toast(r); }, 300); }
```

This also makes the shared work order link (`?ref=wo:WO-24366`) work on the web after sign-in.

### H4. System alerts go to a real banner (in `sysNotify(al)`)

Add as the first lines of `sysNotify`:

```js
if (window.BRPNative && BRPNative.isNative()) {
  if (U && O.KV.get('non:' + U.email) === '1' && al.tagged.some(function (t) { return t.email === U.email; }))
    BRPNative.notify({ title: al.title, body: al.body.slice(0, 180), ref: al.ref || '' });
  return;
}
```

iOS shows the banner even while the app is open. A tap on it runs the `onOpen` handler from H3.

### H5. Haptics on key moments (one line each, optional)

- Emergency alert raised or received: `window.BRPNative && BRPNative.haptic('warning');`
- Request submitted, ticket verified, PO received: `window.BRPNative && BRPNative.haptic('success');`
- Validation error shown: `window.BRPNative && BRPNative.haptic('error');`

### H6. Notification card and permission (in `notifEnv`, `notifText`, `askNotif`)

Inside the app there is no web `Notification` object, so the card today shows the "Add to Home Screen" text. Three small changes:

```js
// notifEnv(): first line
if (window.BRPNative && BRPNative.isNative()) return { has: true, ios: BRPNative.platform() === 'ios', standalone: true, embedded: false, native: true };

// notifText(): first line
if (window.BRPNative && BRPNative.isNative()) return O.KV.get('non:' + U.email) === '1' ? 'On. Alerts that tag you show as banners on this device.' : 'Off. Turn them on to get a banner when an alert tags you.';

// askNotif(): after O.KV.set('nc:' + U.email, '1'); and the say() definition
if (window.BRPNative && BRPNative.isNative()) {
  BRPNative.push.register().then(function (token) { return token ? 'granted' : BRPNative.notifyPermission(); }).then(function (p) {
    if (p === 'granted') O.KV.set('non:' + U.email, '1');
    say(p === 'granted' ? notifText() : 'Blocked. Alerts stay in the bell. To change it, open Settings, BRP One, Notifications.');
  });
  return;
}
```

`push.register()` asks iOS once. The same permission covers local banners (H4). The token it returns is what a push server would need later; log it or send it to the server when one exists.

### H7. Ask for a rating after a positive action (in the host object, `addSatisfaction`)

The rating prompt comes only after something went well. Replace the host's `addSatisfaction` line with:

```js
addSatisfaction: function (r) {
  var out = can('csat.write') ? O.addSatisfaction(Object.assign({}, r, U.role === 'Soldier' ? { by: r && r.anon === false ? U.name : null } : {})) : null;
  var top = out && ((out.scale === '5' && out.score >= 4) || (out.scale !== '5' && out.score >= 3));
  if (top && window.BRPNative) setTimeout(function () { BRPNative.requestReview(); }, 1200);
  return out;
}
```

`requestReview()` limits itself: it asks iOS only after 3 or more positive actions, 2 or more days after first launch, and never twice within 120 days. iOS then decides whether to show it (Apple shows it at most 3 times a year). Do not call it on app open, after an error, or in exchange for anything.

### H8. Status bar on bone screens (optional)

The sign-in cover is ink; workspaces are bone. After sign-in and after sign-out:

```js
window.BRPNative && BRPNative.statusBar(U ? 'light' : 'dark');
```

The page already uses `viewport-fit=cover` and `env(safe-area-inset-*)`. Check the top bar on a notched iPhone; if it sits under the clock, add `padding-top: var(--brp-safe-top)` to the top bar under `html.brp-native`.

### H9. "Test a notification" in the account menu (app only, for testers and App Review)

Add a menu item when `BRPNative.isNative()`:

```js
'<button type="button" data-native-test>Test a notification</button>'  // give it the same class as the other account menu buttons
```

```js
doc.addEventListener('click', function (e) {
  if (!e.target.closest || !e.target.closest('[data-native-test]')) return;
  closeMenu();
  BRPNative.notify({ title: 'Test alert', body: 'This is how BRP One alerts look on this device. Sample data.', ref: '' }).then(function (ok) {
    toast(ok ? 'Test banner sent.' : 'Notifications are off. Turn them on in Settings, BRP One, Notifications.');
  });
});
```

The App Store review notes (APP-STORE.md, section 6) point the reviewer to this item.

## 3. Hooks inside the frames

### F1. "Scan room QR" in the Soldier portal (office app, Soldier view)

In the report form markup, after the Room field (`id="pd-room"`), add the button only in the app:

```js
((window.BRPNative || parent.BRPNative || { isNative: function () { return false; } }).isNative()
  ? '<div class="field"><button type="button" class="btn" data-act="pd-scan">Scan room QR</button></div>' : '')
```

and in the click handler's `switch`:

```js
case 'pd-scan': {
  const N = window.BRPNative || parent.BRPNative;
  N.scanQR({ prompt: 'Point the camera at the QR code on your room door.' }).then(t => {
    if (!t) return;
    const r = N.parseRoom(t);
    if (!r) return toast('That code is not a BRP room code. Type your room instead.');
    const set = (id, v) => { const el = document.getElementById(id); if (!el) return; el.value = v; el.dispatchEvent(new Event('change', { bubbles: true })); };
    set('pd-inst', r.inst);                 // re-renders the form with that installation's buildings
    setTimeout(() => { set('pd-bldg', r.bldg); set('pd-room', r.room); toast('Room ' + r.bldg + '-' + r.room + ' filled in from the door code.'); }, 0);
  });
  return;
}
```

### F2. "Scan room QR" on the field tablet (tablet app, scan sheet)

The tablet already has a scan sheet. In the app, the Start camera button should open the native scanner (WebKit has no `BarcodeDetector`). In the click `switch`, replace `case 'scan-start': startCam(); return;` with:

```js
case 'scan-start': {
  const N = window.BRPNative || parent.BRPNative;
  if (N && N.isNative()) {
    N.scanQR({ prompt: 'Point the camera at a door QR code, a part label or a sensor label.' }).then(t => {
      if (!t) return;
      const r = N.parseRoom(t);
      handleCode(r && r.inst === 'STW' ? 'FS-' + r.bldg + '-' + r.room : t);
    });
    return;
  }
  startCam(); return;
}
```

In the app, also change the button label in `scanSheet()` from "Start camera" to "Scan with camera" when `N.isNative()`. A "Scan room QR" shortcut in the tablet top bar can open the same sheet (`data-act` that sets `ui.sheet = { kind: 'scan' }` or the existing scan button's action).

### F3. Share a work order (office app work order view, tablet ticket view)

Next to the work order title, in the app only:

```js
'<button class="btn sm" data-act="wo-share" data-id="' + w.id + '">Share</button>'
```

```js
case 'wo-share': {
  const N = window.BRPNative || parent.BRPNative, w = /* the work order */;
  N.shareWorkOrder({ id: w.id, title: w.title, place: placeText(w) });
  return;
}
```

On the web, keep any existing share or copy-link button. `N.workOrderLink(id)` gives the same link for a copy button.

## 4. After wiring

1. In `native/`: `npm run sync` (copies the new web build, then `npx cap sync`).
2. `npm run verify-web` checks that the page loads with the bridge and every method returns its web fallback, with no script errors.
3. `node scripts/verify-bridge-mock.mjs` checks the bridge's app-side calls against a fake Capacitor runtime.
4. On the Mac, run on a real iPhone (APP-STORE.md, step 4) and walk through: sign in, accept Face ID, sign out, sign in with Face ID, turn on notifications, raise an alert that tags you, tap the banner, scan a printed room QR, share a work order.
