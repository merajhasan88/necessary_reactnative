declare const __DEV__: boolean | undefined;

/** Whether this is a release build: React Native's `__DEV__` false. Tests in Node have none. */
export function isReleaseBuild(): boolean {
  return typeof __DEV__ !== 'undefined' && __DEV__ === false;
}
