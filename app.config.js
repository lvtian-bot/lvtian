const { withAppBuildGradle, withAndroidManifest } = require('@expo/config-plugins');
const pkg = require('./package.json');

// =====================================================================
// Custom Config Plugins (Replacing original patch-*.js scripts)
// =====================================================================

/**
 * Plugin 1: Disable Android Predictive Back Gesture
 */
const withDisablePredictiveBack = (config) => {
    return withAndroidManifest(config, async (config) => {
        const app = config.modResults.manifest.application?.[0];
        if (app) {
            // Add or update attribute
            app.$['android:enableOnBackInvokedCallback'] = 'false';
        }
        return config;
    });
};

/**
 * Plugin 2: Deeply Custom Build.gradle
 * Includes: Keystore configuration, NDK architecture filtering
 */
const withCustomBuildGradle = (config) => {
    return withAppBuildGradle(config, async (config) => {
        let content = config.modResults.contents;

        // --- A. Inject Keystore Loading Logic ---
        if (!content.includes('keystorePropertiesFile = rootProject.file("../keystore/keystore.properties")')) {
            const keystoreLoader = `
// [Config Plugin] Load keystore properties
def keystorePropertiesFile = rootProject.file("../keystore/keystore.properties")
def keystoreProperties = new Properties()
if (keystorePropertiesFile.exists()) {
    keystoreProperties.load(new FileInputStream(keystorePropertiesFile))
}
`;
            // Insert after apply plugin
            const lastApplyIndex = content.lastIndexOf('apply plugin');
            if (lastApplyIndex !== -1) {
                const endOfLine = content.indexOf('\n', lastApplyIndex) + 1;
                content = content.slice(0, endOfLine) + keystoreLoader + content.slice(endOfLine);
            } else {
                content = keystoreLoader + content;
            }
        }

        // --- B. Inject Release Signing Config ---
        if (!content.includes('keyAlias keystoreProperties["keyAlias"]')) {
            // Inject release block inside signingConfigs {
            // Note: Expo default template usually contains signingConfigs { debug { ... } }
            const releaseBlock = `
        release {
            if (keystorePropertiesFile.exists()) {
                storeFile file(keystoreProperties['storeFile'])
                storePassword keystoreProperties['storePassword']
                keyAlias keystoreProperties['keyAlias']
                keyPassword keystoreProperties['keyPassword']
            } else {
                storeFile file('debug.keystore')
                storePassword 'android'
                keyAlias 'androiddebugkey'
                keyPassword 'android'
            }
        }
`;
            // Simple replacement injection
            content = content.replace(/signingConfigs\s*\{/, 'signingConfigs {' + releaseBlock);

            // Force all build types to use release signing (if present)
            // Replace "signingConfig signingConfigs.debug" with release
            content = content.replace(/signingConfig\s+signingConfigs\.debug/g, 'signingConfig signingConfigs.release');
        }

        // --- D. Inject NDK ABI Filters (arm64-v8a only) ---
        if (!content.includes("abiFilters 'arm64-v8a'")) {
            const ndkBlock = `
        ndk {
            abiFilters 'arm64-v8a'
        }
`;
            // Insert at start of defaultConfig {
            content = content.replace(/defaultConfig\s*\{/, 'defaultConfig {' + ndkBlock);
        }

        config.modResults.contents = content;
        return config;
    });
};

// =====================================================================
// Main Configuration Object
// =====================================================================

module.exports = {
    expo: {
        name: "MDNote",
        slug: "mdnote",
        version: pkg.version,
        orientation: "portrait",
        icon: "./assets/icon.png",
        userInterfaceStyle: "light",
        splash: {
            image: "./assets/icon.png",
            resizeMode: "contain",
            backgroundColor: "#FFFFFF"
        },
        ios: {
            supportsTablet: true,
            bundleIdentifier: "com.mdnote",
            buildNumber: "10"
        },
        android: {
            package: "com.mdnote",
            versionCode: 10,
            enableProGuardInReleaseBuilds: true,
            adaptiveIcon: {
                foregroundImage: "./assets/adaptive-icon.png",
                backgroundColor: "#FFFFFF"
            }
        },
        plugins: [
            "expo-build-properties",
            "expo-font",
            // Referencing plugins defined above
            withDisablePredictiveBack,
            withCustomBuildGradle
        ],

    }
};
