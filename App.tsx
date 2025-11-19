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

function App(): React.JSX.Element {
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
      }
    };
    
    initializeCloud();
  }, [cosConfig]);

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
