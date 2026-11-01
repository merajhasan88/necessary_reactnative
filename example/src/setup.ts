// How an app sets up the SDK: one DeviceTrust for its backend, with the options it chooses.
// Everything else in the example uses what is made here.
import { AppPinOptions, DeviceTrust, StepUpOptions, type PersonalMeasurement } from '@necessarysdk/react-native';
import configured from './backends.json';

/**
 * The backends to choose among, by name: src/backends.json, which a build may replace --
 * `{"Python": "https://…", "TypeScript": "https://…"}`.
 */
export const backends: Record<string, string> = configured as Record<string, string>;

/** A [DeviceTrust] for the backend at [baseUrl]. */
export function setUpDeviceTrust(baseUrl: string, personalMeasurements: Iterable<PersonalMeasurement> = []): DeviceTrust {
  return new DeviceTrust({
    baseUrl,
    // The personal measurements this app allows -- none unless it names them. The backend asks for
    // those it needs, and only what both name is measured. They can change while the app runs:
    // trust.personalMeasurements = new Set([...]).
    personalMeasurements,
    // Step-up: a second key, which the person unlocks to approve one request. factor 'passcode'
    // (the phone's PIN, pattern or password) or 'biometric'; mode 'per_use', or 'windowed' with
    // windowSeconds (Android only). Leave it out for no step-up.
    stepUp: new StepUpOptions({ factor: 'passcode', mode: 'per_use' }),
    // The app PIN, which the backend checks for one request. Its two calls default to the guide's
    // paths. Leave it out for no app PIN.
    appPin: new AppPinOptions(),
  });
}
