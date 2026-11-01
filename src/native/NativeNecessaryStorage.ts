import type { TurboModule } from 'react-native';
import { TurboModuleRegistry } from 'react-native';

/**
 * The phone's secure storage for the installation ID and the pending step-up re-enrolment (the
 * Keychain, readable after the first unlock, on this device only; values encrypted under a key in
 * the platform keystore), and the platform's secure random source.
 */
export interface Spec extends TurboModule {
  read(key: string): Promise<string | null>;
  write(key: string, value: string): Promise<boolean>;
  remove(key: string): Promise<boolean>;
  randomBytes(count: number): Promise<string>;
}

export default TurboModuleRegistry.get<Spec>('NecessaryStorage');
