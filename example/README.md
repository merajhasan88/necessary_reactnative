# The example app

The example app puts every piece of the SDK in a working app, against a sample backend. The
package's README carries the same steps.

## Install it

The sample backends live in the repository, not in the package, so start from a clone.

1. Clone the repository:

   ```sh
   git clone https://github.com/merajhasan88/necessary_reactnative.git
   cd necessary_reactnative
   ```

2. Start a sample backend on your computer. It answers on `127.0.0.1` only. In Python 3.10 or later:

   ```sh
   pip install --require-hashes -r backend/python/requirements.txt
   python3 backend/python/server.py --port 8787 --schema contract/report-1/android-8-ios-5/report.schema.json
   ```

   The TypeScript and C# samples run the same way; their commands are in
   [`backend/README.md`](https://github.com/merajhasan88/necessary_reactnative/blob/main/backend/README.md).
3. Install the example's packages (Node.js 22 or later), from `example/`:

   ```sh
   cd example
   npm ci
   ```

4. Name the backend in `example/src/backends.json`, then run the app:
   - **On an Android emulator**, a debug build reaches your computer at `10.0.2.2`:
     `{"Sample": "http://10.0.2.2:8787"}`, then `npx react-native run-android`.
   - **On an Android phone** connected by USB with USB debugging on, forward the port first:
     `adb reverse tcp:8787 tcp:8787`, name `{"Sample": "http://127.0.0.1:8787"}`, then
     `npx react-native run-android`.
   - **A release build**, on Android or iOS, talks only HTTPS: the SDK refuses an `http://` address in
     a release build. Put the sample behind an HTTPS proxy on a name the phone can resolve, with a
     certificate the phone trusts, and name that address:
     `{"Sample": "https://backend.example.com"}`, then
     `npx react-native run-android --mode release`.
   - **On an iPhone**, run `pod install` in `example/ios`, open `example/ios/NecessaryExample.xcworkspace`
     in Xcode on a Mac, choose your team under Signing & Capabilities, and run with the iPhone
     connected. An iPhone reaches your computer over your network, so name the address of the HTTPS
     proxy.

   To offer several backends, name each: `{"Python": "https://…", "TypeScript": "https://…"}`. A debug
   build measures itself as one — `debuggable` in `app_identity` — so judge the measurements on a release
   build.

## Test it on a phone, step by step

With several backends, tap one at the top and run the steps once for each. Every result line carries a
✓ when the backend did what it should, a red ! when it did not.

1. **Installation → Start.** Expect: `Installation …, proved; step-up on.` On a phone without a screen
   lock, step-up is off: `step-up off here (…)`, and step 7 cannot pass.
2. **Measurements:** switch on **All of them**, tap **Ask for the location permission** and allow it.
   Once is enough; the switches reset when the app restarts.
3. **Scan.** Expect: `The backend answered next: allow, report …` — the sample backends answer
   `scan_again` when a measurement could not be read, and `review` when its figures contradict each
   other. Under **Hooks, gadgets and memory changes** every row reads `measured`, none `not asked`. Open
   any row for the fields the phone sent.
4. **Account → Sign in.** Expect: `An account session for this installation.`
5. **Requests → Protected request.** Expect: ✓ `{"done":"/v1/demo/echo"}`.
6. **Sensitive, without approval.** Expect: ✓ `Refused, as it should be: 403 needs_approval`.
7. **Sensitive, with step-up**, then unlock with the phone's passcode. Expect: ✓
   `{"done":"/v1/demo/sensitive"}`.
8. Type 6 digits in **App PIN**, then **Set the app PIN**. Expect: ✓ `Set, with the account password.`
9. **Sensitive, with the app PIN.** Expect: ✓ `{"done":"/v1/demo/sensitive"}`.
10. **Requests a backend must refuse:** tap each of the four. Expect a ✓ on each: `Refused, as it should
    be: 401 proof_reused` for the request sent twice, `401 proof_not_accepted` for the other three.

If the phone's screen lock is removed and set again, the step-up key dies: step 7 then shows `The phone
said STEPUP_KEY_INVALIDATED` (on Android 9, `STEPUP_KEY_UNAVAILABLE`). Tap **Re-enrol the step-up key**
and unlock with the passcode — expect ✓ `{"stepup_key_registered":true}` — and step 7 passes again. The
new key is that account's alone. If the lock was off at step 1 and set afterwards, **Start again** says
`step-up off here (STEPUP_REENROL_PENDING)`: the backend took the installation without a step-up key, so
re-enrol the same way after step 4.

The app PIN belongs to the account, not to the phone. Phones signed in with the same handle share it: a
PIN set on one unlocks requests on the other, and before any is set, step 9 answers `app_pin_not_set`.
Sign in with another handle for an account of its own.

## A session copied to another phone

A session token copied off one phone must be useless on another. You need two phones running the
example against the same backend.

1. **Phone A:** steps 1 and 4 above, then **Requests a backend must refuse → Share this phone's
   session**, and send the text to yourself.
2. Get the text to phone B, for example in a note or a message to yourself. It holds phone A's session
   and installation ID; the sample's sessions last ten minutes.
3. **Phone B:** step 1 above, on the same backend.
4. **Phone B:** paste the text into **A session from another phone**, then tap **Use it here**. Expect: ✓
   `Refused, as it should be: 401 invalid_installation_signature`. Phone B's key cannot sign for phone A's
   installation, even when the request names it.

If step 4 reads `The session is no longer valid: sign in again`, phone A's session has expired: sign in
again on phone A and share it again.

## Measurement by measurement

What each measurement is and every field it carries:
[`doc/measurements.md`](https://github.com/merajhasan88/necessary_reactnative/blob/main/doc/measurements.md).
On a phone of your own you can watch these change, one at a time: make the change, tap **Scan**, open the
measurement's row, and change it back afterwards.

| Measurement | Change | The row then shows |
|---|---|---|
| `developer_settings` (Android) | Settings → About phone → tap Build number seven times; then Developer options → USB debugging | `developer_options_enabled`, then `adb_enabled`, true |
| `network` | turn on a VPN app; or set a manual proxy on your Wi-Fi network | `vpn_active` true, the tunnel's interface in `interfaces` (Android) or `scoped_interfaces` (iOS); `http_proxy_configured` true |
| `local_addresses` | switch between Wi-Fi and mobile data | the phone's own addresses, per interface |
| `screen_capture` | start the screen recorder (Android 15 and later; on iOS from Control Center); connect an external display | `recording` true; `external_displays` 1 |
| `location` | tap **Ask for the location permission** and allow it | the `permission`, the coordinates and their `age_seconds` |
| `mock_location` | Android: Developer options → Select mock location app, and run a mock-location app; iOS: simulate a location from Xcode while the app runs from it | `mock` true |
| `accessibility` (Android) | Settings → Accessibility → turn on a service such as Select to Speak; or choose another keyboard | the service in `services`; the keyboard in `keyboard` |
| `notification_access` (Android) | Settings → Notification access (under Special app access) → allow an app | the app in `listeners` |
| `other_access` (Android) | install AnyDesk, TeamViewer QuickSupport, RustDesk or AirDroid; or make an app a device administrator | the app in `remote_access_apps`; in `device_admins` |
| `app_identity` | install a build of the example made with other code | other hashes; a debug build reads `debuggable` true |
| `debug_state` (Android) | in Android Studio, Run → Attach Debugger to Android Process, on a debug build | `debugger_connected` true |
| `code_signing` (iOS) | run a development build from Xcode | `get_task_allow` true |

The rest — root and jailbreak traces, Frida and other hooking tools, code changed in memory, an emulator
or the Simulator — needs a device you are allowed to change: never a phone you depend on. On an Android
emulator `emulator.suspected` is true, and a `userdebug` image shows a debuggable, test-keys build in
`system_properties` and `root_files`; on the iOS Simulator `simulator.is_simulator` is true. Frida on a
test device shows in `runtime_maps`, `frida_ports`, `instrumentation_threads`, `exec_mappings` and
`code_integrity` on Android, and in `dyld_images` and `code_integrity` on iOS.

