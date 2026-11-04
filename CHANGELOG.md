# Changelog

## Unreleased

- `runtime_maps`, `instrumentation_threads` and iOS `dyld_images` leave the app's own folders, package name
  and main executable out of what they read as names.
- Android: `root_shell` keeps the shell's error stream out of `su_path`, where a complaint that `which`
  is missing would have read as `su` found.
- Android: a step-up signature that fails after the person approved, with any exception, answers the app;
  a keystore's `ProviderException` there used to end the app. A location permission request is answered
  when its activity goes, or the runtime does, with what the app holds then; it used to wait for ever.
- A step-up key the phone lost and a re-enrolment made again leaves approvals waiting until the backend
  takes it, like a key replaced.
- A backend's answer that lacks a field the SDK needs is an `ApiException` (`invalid_backend_answer`): it
  used to pass unseen, or to be a `TypeError` for a scan's challenge.
- The Python sample backend answers a malformed request: it used to drop the connection. Its other
  requests answer as before.
- `doc/measurements.md`: `installer_package` is left out or null when no installer is named, as the
  collectors send it; the report's format is the same for every SDK, as it says now.

## 0.1.5

The first release of Necessary for React Native: the client of the integration guide, for Android and
iOS.

- `DeviceTrust`: one object for your backend, the personal measurements your app enables, step-up and
  the app PIN — `start`, `prove`, `scan`, `signRequest`, `reenrolStepUp`, `setAppPin`, `reset` and
  `close`; one installation at a time, every persistent write held by a reset; calls at once share one
  result.
- The guide's five calls (`DeviceTrustClient`) over HTTPS under the base URL your app sets, or over a
  transport of your own; the protocol errors acted on once; request proofs, step-up proofs, the app
  PIN's request and the operation a scan names, byte for byte as the shared vectors
  (`vectors/client_server.json`) say.
- The installation key in Android Keystore (StrongBox first) or the Secure Enclave, made only where
  the keystore, answering, holds none; the step-up key, deleted only when Android says it is dead;
  every Android failure with what failed beneath it.
- The collectors: version 10 on Android, version 8 on iOS, as `doc/measurements.md` describes them;
  reports valid by the contract (`contract/report-1/android-8-ios-5/`).
- Screen protection while a secret is typed; the installation ID kept in the platform's secure storage.
- The example app (React Native 0.88) and three sample backends (Python, TypeScript, C#).
