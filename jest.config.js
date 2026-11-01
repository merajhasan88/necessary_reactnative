/** The SDK's tests run in Node: the phone's native side is replaced, as in each test. */
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  roots: ['<rootDir>/test'],
  moduleNameMapper: {
    '^react-native$': '<rootDir>/test/support/reactNativeStub.ts',
  },
  transform: {
    '^.+\\.tsx?$': ['ts-jest', { tsconfig: 'tsconfig.json', diagnostics: { warnOnly: false } }],
  },
};
