import 'react-native-get-random-values';
import './src/i18n'; // Initialize i18next
import React, { useCallback, useEffect, useRef } from 'react';
import { NavigationContainer, createNavigationContainerRef } from '@react-navigation/native';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { KeyboardProvider } from 'react-native-keyboard-controller';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { AppNavigator } from './src/navigation/AppNavigator';
import { StyleSheet, StatusBar, DeviceEventEmitter } from 'react-native';

// Imports for cloud service initialization
import { useSettingsStore } from './src/store/useSettingsStore';
import { cloudService } from './src/services/CloudService';

import { ChatNotificationTarget, RootStackParamList } from './src/types/navigation';
import { startChatNotifications } from './src/services/chatNotifications';
import { startChatBackgroundPush } from './src/services/chatBackgroundPush';


// Create navigation ref for programmatic navigation
const navigationRef = createNavigationContainerRef<RootStackParamList>();

function App(props: { sharedText?: string }): React.JSX.Element | null {
  useEffect(startChatBackgroundPush, []);
  const pendingReply = useRef<ChatNotificationTarget>(undefined);
  const openPendingReply = useCallback(() => {
    if (!navigationRef.isReady() || !pendingReply.current) return;
    const notificationTarget = pendingReply.current;
    pendingReply.current = undefined;
    navigationRef.navigate('MainTabs', {
      screen: 'Chat',
      params: { screen: 'ChatScreen', params: { notificationTarget } },
    }, { pop: true });
  }, []);
  useEffect(() => startChatNotifications(
    () => navigationRef.getCurrentRoute()?.name === 'ChatScreen',
    target => { pendingReply.current = target; openPendingReply(); },
  ), [openPendingReply]);

  const pendingShares = useRef<string[]>([]);
  const openPendingShare = useCallback(() => {
    if (!navigationRef.isReady() || navigationRef.getCurrentRoute()?.name === 'FlashNoteEditor') return;
    const sharedText = pendingShares.current.shift();
    if (sharedText === undefined) return;
    navigationRef.navigate('FlashNoteEditor', {
      flashNoteId: 'new',
      initialContent: sharedText,
      fromShare: true,
    });
  }, []);
  const handleNavigationReady = useCallback(() => {
    openPendingReply();
    openPendingShare();
  }, [openPendingReply, openPendingShare]);

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

  const handleSharedContent = useCallback((sharedText: unknown) => {
    if (typeof sharedText !== 'string' || !sharedText.trim()) return;
    pendingShares.current.push(sharedText);
    openPendingShare();
  }, [openPendingShare]);

  useEffect(() => {
    handleSharedContent(props.sharedText);
  }, [props.sharedText, handleSharedContent]);

  useEffect(() => {
    const subscription = DeviceEventEmitter.addListener('onShareReceived', handleSharedContent);
    return () => subscription.remove();
  }, [handleSharedContent]);

  if (!hasHydrated) {
    return null;
  }

  return (
    <GestureHandlerRootView style={styles.container}>
      <KeyboardProvider>
        {/* edge-to-edge 下状态栏透明，底色由各页头部背景透出 */}
        <StatusBar barStyle="dark-content" />
        <SafeAreaProvider>
          <NavigationContainer ref={navigationRef} onReady={handleNavigationReady} onStateChange={openPendingShare}>
            <AppNavigator />
          </NavigationContainer>

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
