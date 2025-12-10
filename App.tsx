import 'react-native-get-random-values';
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
import * as SecureStore from 'expo-secure-store';
import { theme } from './src/utils/theme';
import { useShareStore } from './src/store/useShareStore';
import { RootStackParamList } from './src/types/navigation';
import { SHARE_RECEIVED_EVENT } from './src/services/FlashNoteService';


// Create navigation ref for programmatic navigation
const navigationRef = createNavigationContainerRef<RootStackParamList>();

function App(props: { sharedText?: string }): React.JSX.Element {
  // Logic to initialize cloud service based on settings
  const { cosConfig, hasHydrated } = useSettingsStore();

  useEffect(() => {
    const initializeCloud = async () => {
      if (!hasHydrated) {
        console.log('[App] Waiting for settings hydration...');
        return;
      }

      try {
        const { bucket, region } = cosConfig;
        const storedSecretId = await SecureStore.getItemAsync('COS_SECRET_ID');
        const storedSecretKey = await SecureStore.getItemAsync('COS_SECRET_KEY');

        if (storedSecretId && storedSecretKey && bucket && region) {
          const secretId = storedSecretId;
          const secretKey = storedSecretKey;
          console.log('[App] Initializing cloud service with bucket:', bucket);
          const provider = new TencentCOSProvider(secretId, secretKey, bucket, region);
          cloudService.setProvider(provider);
          console.log('[App] Cloud service initialized successfully');
        } else {
          console.log('[App] Cloud service not configured - missing credentials or config');
          cloudService.setProvider(null);
        }
      } catch (error) {
        console.error('[App] Error initializing cloud service:', error);
        cloudService.setProvider(null);
      } finally {
        cloudService.markInitialized();
      }

    };

    // Explicitly call the async function without await (useEffect cannot be async)
    // The initialization will complete in the background
    void initializeCloud();
  }, [cosConfig, hasHydrated]);

  // Shared handler for processing shared content
  const handleSharedContent = React.useCallback(async (sharedText: string) => {
    console.log('[App] Received share content, length:', sharedText.length);

    // Store the pending share content
    useShareStore.getState().setPendingShare(sharedText);

    // Emit event for active listeners (like TimelineScreen)
    DeviceEventEmitter.emit(SHARE_RECEIVED_EVENT, { content: sharedText });


    // Wait for navigation to be ready (with timeout)
    let attempts = 0;
    const maxAttempts = 30; // 3 seconds max wait
    while (!navigationRef.isReady() && attempts < maxAttempts) {
      console.log(`[App] Waiting for navigation ref... attempt ${attempts + 1}`);
      await new Promise<void>(resolve => setTimeout(resolve, 100));
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
