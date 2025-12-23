const { withAppBuildGradle, withAndroidManifest, withGradleProperties } = require('@expo/config-plugins');
const pkg = require('./package.json');

// =====================================================================
// Custom Config Plugins
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

        // --- E. Inject Lint Options to suppress ExtraTranslation errors ---
        if (!content.includes("lintOptions")) {
            const lintBlock = `
        lintOptions {
            checkReleaseBuilds false
            abortOnError false
        }
`;
            // Insert before defaultConfig {
            content = content.replace(/defaultConfig\s*\{/, lintBlock + 'defaultConfig {');
        }

        config.modResults.contents = content;
        return config;
    });
};

/**
 * Plugin 3: Custom Gradle Properties
 * Sets reactNativeArchitectures to prevent third-party libs from building 32-bit archs
 */
const withCustomGradleProperties = (config) => {
    return withGradleProperties(config, (config) => {
        const key = 'reactNativeArchitectures';
        const value = 'arm64-v8a';

        // Check if already exists
        const existing = config.modResults.find(item => item.key === key);
        if (existing) {
            existing.value = value;
        } else {
            config.modResults.push({
                type: 'property',
                key,
                value,
            });
        }
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
        locales: {
            en: "./config-locales/en.json",
            zh: "./config-locales/zh.json"
        },
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
            buildNumber: "13"
        },
        android: {
            package: "com.mdnote",
            versionCode: 13,
            enableProGuardInReleaseBuilds: true,
            adaptiveIcon: {
                foregroundImage: "./assets/adaptive-icon.png",
                backgroundColor: "#FFFFFF"
            }
        },
        extra: {
            eas: {
                projectId: "71e44e22-3174-44f1-8fbf-b84c2295dfd8"
            }
        },
        plugins: [
            [
                "expo-build-properties",
                {
                    "android": {
                        "usesCleartextTraffic": true
                    }
                }
            ],
            "expo-font",
            "expo-asset",
            // Referencing plugins defined above
            withDisablePredictiveBack,
            withCustomBuildGradle,
            withCustomGradleProperties,
            // Custom Share Plugin
            require("./plugins/withAndroidShare")
        ],

    }
};

