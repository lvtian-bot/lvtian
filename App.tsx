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
import { useFileMetadataStore } from './src/store/useFileMetadataStore';

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
    const { DeviceEventEmitter } = require('react-native');

    const subscription = DeviceEventEmitter.addListener('onShareReceived', handleSharedContent);

    return () => {
      subscription.remove();
    };
  }, [handleSharedContent]);

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
