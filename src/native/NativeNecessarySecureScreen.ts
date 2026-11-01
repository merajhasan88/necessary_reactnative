import type { TurboModule } from 'react-native';
import { TurboModuleRegistry } from 'react-native';

/** Protection of the app's window while a secret is typed. */
export interface Spec extends TurboModule {
  protect(on: boolean): Promise<Object>;
}

export default TurboModuleRegistry.get<Spec>('NecessarySecureScreen');
