# Changelog

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
