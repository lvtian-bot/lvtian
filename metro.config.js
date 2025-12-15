const { getDefaultConfig } = require('expo/metro-config');

/** @type {import('expo/metro-config').MetroConfig} */
const config = getDefaultConfig(__dirname);

// Add 'html' to asset extensions so expo-asset can load .html files
config.resolver.assetExts.push('html');

module.exports = config;
