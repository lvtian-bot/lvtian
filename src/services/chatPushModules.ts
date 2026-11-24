import { requireOptionalNativeModule } from 'expo';
import { Platform } from 'react-native';

// The installed APK owns Firebase configuration across OTA updates. Load the
// JS wrappers only when the corresponding native packages exist in that APK.
function loadPushModules() {
    if (Platform.OS !== 'android' || !requireOptionalNativeModule('ExpoPushTokenManager')
        || !requireOptionalNativeModule('ExpoBackgroundNotificationTasksModule')
        || !requireOptionalNativeModule('ExpoTaskManager')) return;
    return {
        notifications: require('expo-notifications') as typeof import('expo-notifications'),
        taskManager: require('expo-task-manager') as typeof import('expo-task-manager'),
    };
}

export const pushModules = loadPushModules();
