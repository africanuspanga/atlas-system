// Metro config for a pnpm + Turborepo monorepo (Expo docs: guides/monorepos).
// Watches the workspace root so shared packages (@atlas/i18n) hot-reload,
// and resolves modules from both the app and the root node_modules.
const { getDefaultConfig } = require("expo/metro-config");
const path = require("path");

const projectRoot = __dirname;
const workspaceRoot = path.resolve(projectRoot, "../..");

const config = getDefaultConfig(projectRoot);

config.watchFolders = [workspaceRoot];
config.resolver.nodeModulesPaths = [
  path.resolve(projectRoot, "node_modules"),
  path.resolve(workspaceRoot, "node_modules"),
];
// NOTE: keep hierarchical lookup ENABLED — pnpm resolves transitive deps
// (e.g. expo-router → @expo/metro-runtime) by walking up from each
// package's real path inside node_modules/.pnpm.

module.exports = config;
