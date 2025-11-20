import './src/i18n'; // Initialize i18next
import React, { useEffect } from 'react';
import { NavigationContainer } from '@react-navigation/native';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { AppNavigator } from './src/navigation/AppNavigator';
import { StyleSheet, StatusBar } from 'react-native'; // Import StatusBar

// Imports for cloud service initialization
import { useSettingsStore } from './src/store/useSettingsStore';
import { cloudService } from './src/services/CloudService';
import { TencentCOSProvider } from './src/services/TencentCOSProvider';
import * as Keychain from 'react-native-keychain';
import { theme } from './src/utils/theme'; // Import theme
import { flashNoteService } from './src/services/FlashNoteService';
import { Alert } from 'react-native';
import { t } from 'i18next';

function App(props: { sharedText?: string }): React.JSX.Element {
  // Logic to initialize cloud service based on settings
  const { cosConfig } = useSettingsStore();
  const [isCloudInitialized, setIsCloudInitialized] = React.useState(false);

  useEffect(() => {
    const initializeCloud = async () => {
      try {
        const { bucket, region } = cosConfig;
        const credentials = await Keychain.getGenericPassword();

        if (credentials && credentials.username && credentials.password && bucket && region) {
          const secretId = credentials.username;
          const secretKey = credentials.password;
          console.log('Valid COS config and credentials found. Initializing TencentCOSProvider.');
          const provider = new TencentCOSProvider(secretId, secretKey, bucket, region);
          cloudService.setProvider(provider);
        } else {
          console.log('No valid COS config or credentials. Cloud service is disabled.');
          cloudService.setProvider(null);
        }
      } catch (error) {
        console.error('Error initializing cloud service:', error);
        cloudService.setProvider(null);
      } finally {
        setIsCloudInitialized(true);
      }
    };

    initializeCloud();
  }, [cosConfig]);

  // Handle Initial Share (Cold Start)
  useEffect(() => {
    if (props.sharedText && isCloudInitialized) {
      const handleInitialShare = async () => {
        try {
          await flashNoteService.addNote(props.sharedText!);
          Alert.alert(
            t('common.success'),
            t('timeline.savedFromShare', { defaultValue: '分享内容已保存到闪念笔记' })
          );
        } catch (error) {
          console.error('Failed to save initial shared content:', error);
          Alert.alert(t('common.error'), t('timeline.saveError'));
        }
      };
      handleInitialShare();
    }
  }, [props.sharedText, isCloudInitialized]);

  // Share Intent Handler (Warm Start)
  useEffect(() => {
    const { DeviceEventEmitter } = require('react-native');

    const handleShareReceived = async (sharedText: string) => {
      console.log('App.tsx: onShareReceived event received:', sharedText);

      // Wait for cloud initialization if needed
      if (!isCloudInitialized) {
        console.log('App.tsx: Cloud not initialized yet, waiting...');
        // Simple retry logic or just proceed if we trust addNote handles it
      }

      try {
        await flashNoteService.addNote(sharedText);
        Alert.alert(
          t('common.success'),
          t('timeline.savedFromShare', { defaultValue: '分享内容已保存到闪念笔记' })
        );
      } catch (error) {
        console.error('Failed to save shared content:', error);
        Alert.alert(t('common.error'), t('timeline.saveError'));
      }
    };

    console.log('App.tsx: Registering onShareReceived listener');
    const subscription = DeviceEventEmitter.addListener('onShareReceived', handleShareReceived);

    return () => {
      console.log('App.tsx: Removing onShareReceived listener');
      subscription.remove();
    };
  }, [isCloudInitialized]); // Add isCloudInitialized to dependency to ensure we have latest state if needed, though ref is better. 
  // Actually, re-binding listener on state change is fine for this low freq event.

  return (
    <GestureHandlerRootView style={styles.container}>
      <StatusBar barStyle="dark-content" backgroundColor={theme.colors.surface} />
      <SafeAreaProvider>
        <NavigationContainer>
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
