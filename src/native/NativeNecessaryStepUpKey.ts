import type { TurboModule } from 'react-native';
import { TurboModuleRegistry } from 'react-native';

/** The step-up key: a second key that the person must unlock with the screen lock. */
export interface Spec extends TurboModule {
  getOrCreateKey(factor: string, mode: string, windowSeconds: number): Promise<Object>;
  sign(payload: string, reason: string, mode: string): Promise<string>;
  deleteKey(): Promise<boolean>;
}

export default TurboModuleRegistry.get<Spec>('NecessaryStepUpKey');
