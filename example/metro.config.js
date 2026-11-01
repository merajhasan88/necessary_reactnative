// The example runs the SDK from this repository's source (../src): Metro watches the package, and
// React Native and React come from the example's own node_modules only, never a second copy.
const path = require('path');
const { getDefaultConfig, mergeConfig } = require('@react-native/metro-config');

const root = path.resolve(__dirname, '..');
const pak = require('../package.json');
const shared = ['react', 'react-native', ...Object.keys(pak.peerDependencies || {})];
const escape = (value) => value.replace(/[/\-\\^$*+?.()|[\]{}]/g, '\\$&');

const config = {
  watchFolders: [root],
  resolver: {
    blockList: [...new Set(shared)].map(
      (name) => new RegExp(`^${escape(path.join(root, 'node_modules', name))}\\/.*$`),
    ),
    extraNodeModules: {
      ...Object.fromEntries([...new Set(shared)].map((name) => [name, path.join(__dirname, 'node_modules', name)])),
      [pak.name]: root,
    },
    nodeModulesPaths: [path.join(__dirname, 'node_modules')],
  },
};

module.exports = mergeConfig(getDefaultConfig(__dirname), config);
