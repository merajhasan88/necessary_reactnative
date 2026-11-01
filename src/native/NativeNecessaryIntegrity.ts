import type { TurboModule } from 'react-native';
import { TurboModuleRegistry } from 'react-native';

/** The collector: measures what a challenge asks for and the app enabled, and nothing else. */
export interface Spec extends TurboModule {
  collect(
    requiredProbes: string[],
    challengeNonce: string,
    optionalProbes: string[],
    enabledMeasurements: string[],
  ): Promise<Object>;
  requestLocationPermission(): Promise<string>;
}

export default TurboModuleRegistry.get<Spec>('NecessaryIntegrity');
