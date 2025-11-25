import './src/i18n'; // Initialize i18next
import React, { useEffect } from 'react';
import { NavigationContainer, createNavigationContainerRef } from '@react-navigation/native';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { AppNavigator } from './src/navigation/AppNavigator';
import { StyleSheet, StatusBar, DeviceEventEmitter } from 'react-native';

// Imports for cloud service initialization
import { useSettingsStore } from './src/store/useSettingsStore';
import { cloudService } from './src/services/CloudService';
import { TencentCOSProvider } from './src/services/TencentCOSProvider';
import * as Keychain from 'react-native-keychain';
import { theme } from './src/utils/theme';
import { flashNoteService, SHARE_RECEIVED_EVENT } from './src/services/FlashNoteService';
import { Alert } from 'react-native';
import { t } from 'i18next';
import { useFileMetadataStore } from './src/store/useFileMetadataStore';
import { useShareStore } from './src/store/useShareStore';
import { RootStackParamList } from './src/types/navigation';

// Create navigation ref for programmatic navigation
const navigationRef = createNavigationContainerRef<RootStackParamList>();

function App(props: { sharedText?: string }): React.JSX.Element {
  // Logic to initialize cloud service based on settings
  const { cosConfig } = useSettingsStore();

  useEffect(() => {
    const initializeCloud = async () => {
      try {
        const { bucket, region } = cosConfig;
        const credentials = await Keychain.getGenericPassword();

        if (credentials && credentials.username && credentials.password && bucket && region) {
          const secretId = credentials.username;
          const secretKey = credentials.password;
          const provider = new TencentCOSProvider(secretId, secretKey, bucket, region);
          cloudService.setProvider(provider);
        } else {
          cloudService.setProvider(null);
        }
      } catch (error) {
        console.error('Error initializing cloud service:', error);
        cloudService.setProvider(null);
      }
    };

    initializeCloud();
  }, [cosConfig]);

  // Shared handler for processing shared content
  const handleSharedContent = React.useCallback(async (sharedText: string) => {
    console.log('[App] Received share content, length:', sharedText.length);

    // Store the pending share content
    useShareStore.getState().setPendingShare(sharedText);

    // Wait for navigation to be ready (with timeout)
    let attempts = 0;
    const maxAttempts = 30; // 3 seconds max wait
    while (!navigationRef.isReady() && attempts < maxAttempts) {
      console.log(`[App] Waiting for navigation ref... attempt ${attempts + 1}`);
      await new Promise(resolve => setTimeout(resolve, 100));
      attempts++;
    }

    // Navigate to Timeline tab
    if (navigationRef.isReady()) {
      navigationRef.navigate('MainTabs', {
        screen: 'Timeline'
      } as any);
      console.log('[App] Navigated to Timeline');
    } else {
      console.warn('[App] Navigation ref not ready after waiting');
      // Even if navigation fails, the content is stored and will be processed
      // when user manually navigates to Timeline
    }
  }, []);

  // Clear stale uploading states on app launch
  useEffect(() => {
    useFileMetadataStore.getState().resetUploadingToFailed();
  }, []);

  // Handle Initial Share (Cold Start)
  useEffect(() => {
    if (props.sharedText) {
      handleSharedContent(props.sharedText);
    }
  }, [props.sharedText, handleSharedContent]);

  // Share Intent Handler (Warm Start)
  useEffect(() => {
    const subscription = DeviceEventEmitter.addListener('onShareReceived', handleSharedContent);

    return () => {
      subscription.remove();
    };
  }, [handleSharedContent]);

  return (
    <GestureHandlerRootView style={styles.container}>
      <StatusBar barStyle="dark-content" backgroundColor={theme.colors.surface} />
      <SafeAreaProvider>
        <NavigationContainer ref={navigationRef}>
          <AppNavigator />
        </NavigationContainer>
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
});

export default App;
