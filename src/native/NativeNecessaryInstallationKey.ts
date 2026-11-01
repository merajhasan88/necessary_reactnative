import type { TurboModule } from 'react-native';
import { TurboModuleRegistry } from 'react-native';

/** The installation key, in the phone's keystore: made on first use, never exported. */
export interface Spec extends TurboModule {
  getOrCreateKey(): Promise<Object>;
  sign(payload: string): Promise<string>;
  deleteKey(): Promise<boolean>;
  reinstallHintIdentifier(): Promise<string>;
}

export default TurboModuleRegistry.get<Spec>('NecessaryInstallationKey');
