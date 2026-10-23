import 'react-native-get-random-values';
import './src/i18n'; // Initialize i18next
import React, { useEffect } from 'react';
import { NavigationContainer, createNavigationContainerRef } from '@react-navigation/native';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { KeyboardProvider } from 'react-native-keyboard-controller';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { AppNavigator } from './src/navigation/AppNavigator';
import { StyleSheet, StatusBar, DeviceEventEmitter } from 'react-native';

// Imports for cloud service initialization
import { useSettingsStore } from './src/store/useSettingsStore';
import { cloudService } from './src/services/CloudService';

import { theme } from './src/utils/theme';
import { useShareStore } from './src/store/useShareStore';
import { RootStackParamList } from './src/types/navigation';
import { SHARE_RECEIVED_EVENT, flashNoteService } from './src/services/FlashNoteService';
import { FlashNoteInputModal } from './src/components/FlashNoteInputModal'; // Global Modal


// Create navigation ref for programmatic navigation
const navigationRef = createNavigationContainerRef<RootStackParamList>();

function App(props: { sharedText?: string }): React.JSX.Element | null {
  // Global Modal State
  const [isGlobalModalVisible, setIsGlobalModalVisible] = React.useState(false);
  const [globalShareContent, setGlobalShareContent] = React.useState<string>('');
  // Logic to initialize cloud service based on settings
  const { webDavConfig, cloudProvider, hasHydrated } = useSettingsStore();

  useEffect(() => {
    const initializeCloud = async () => {
      if (!hasHydrated) {
        console.log('[App] Waiting for settings hydration...');
        return;
      }

      await cloudService.initProvider();
    };

    // Initialize cloud service only, load AI sessions when history page opens
    initializeCloud();
  }, [webDavConfig, cloudProvider, hasHydrated]);

  // Shared handler for processing shared content
  const handleSharedContent = React.useCallback(async (sharedText: string) => {
    console.log('[App] handleSharedContent triggered. Content length:', sharedText?.length);
    console.log('[App] Content preview:', sharedText?.substring(0, 20));

    // Store the pending share content
    useShareStore.getState().setPendingShare(sharedText);

    // Show Global Modal immediately
    console.log('[App] Setting global modal visible');
    setGlobalShareContent(sharedText);
    setIsGlobalModalVisible(true);

    // Also emit event just in case other components need to know (optional)
    DeviceEventEmitter.emit(SHARE_RECEIVED_EVENT, { content: sharedText });
  }, []);


  // Handle Initial Share (Cold Start)
  useEffect(() => {
    if (props.sharedText) {
      console.log('[App] Cold start with sharedText prop:', props.sharedText?.substring(0, 20));
      handleSharedContent(props.sharedText);
    } else {
      console.log('[App] Cold start check: No sharedText prop found.');
    }
  }, [props.sharedText, handleSharedContent]);

  // Share Intent Handler (Warm Start)
  useEffect(() => {
    console.log('[App] Setting up onShareReceived listener');
    const subscription = DeviceEventEmitter.addListener('onShareReceived', (content) => {
      console.log('[App] Event onShareReceived captured!');
      handleSharedContent(content);
    });

    return () => {
        console.log('[App] Removing onShareReceived listener');
        subscription.remove();
    };
  }, [handleSharedContent]);

  if (!hasHydrated) {
    return null;
  }

  return (
    <GestureHandlerRootView style={styles.container}>
      <KeyboardProvider>
        <StatusBar barStyle="dark-content" backgroundColor={theme.colors.surface} />
        <SafeAreaProvider>
          <NavigationContainer ref={navigationRef}>
            <AppNavigator />
          </NavigationContainer>

          {/* Global Share Input Modal */}
          <FlashNoteInputModal
            visible={isGlobalModalVisible}
            initialContent={globalShareContent}
            onSave={async (id, content) => {
              try {
                // Determine if it should be saved as Note or Todo based on some heuristic? 
                // For now, default to Note as per request "Flash Note Dialog"
                await flashNoteService.addNote(content);
                // Also notify list to refresh
                DeviceEventEmitter.emit(SHARE_RECEIVED_EVENT, { content: '' }); // Hack to trigger refresh if listener exists, or usually FLASH_NOTES_UPDATED_EVENT is better
              } catch (e) {
                console.error("Failed to save shared note", e);
              } finally {
                setIsGlobalModalVisible(false);
                setGlobalShareContent('');
                useShareStore.getState().clearPendingShare();
              }
            }}
            onCancel={() => {
              setIsGlobalModalVisible(false);
              setGlobalShareContent('');
              useShareStore.getState().clearPendingShare();
            }}
          />
        </SafeAreaProvider>
      </KeyboardProvider>
    </GestureHandlerRootView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
});

export default App;
