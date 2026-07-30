// https://docs.expo.dev/guides/using-eslint/
const { defineConfig } = require('eslint/config');
const expoConfig = require("eslint-config-expo/flat");

module.exports = defineConfig([
  expoConfig,
  {
    // scripts/ holds node-only tooling (asset generation, template reset) —
    // not app code shipped through Metro.
    ignores: ["dist/*", "scripts/*"],
  }
]);
