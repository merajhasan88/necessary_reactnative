/** React Native, as the tests see it: no native modules, the platform the test sets. */
export const Platform = { OS: 'android' as string };
export const TurboModuleRegistry = {
  get: (): null => null,
  getEnforcing: (name: string): never => {
    throw new Error(`No native module ${name} in tests.`);
  },
};
