import React from 'react';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { TabNavigator } from './TabNavigator';
import { PreviewScreen } from '../screens/PreviewScreen';
import { EditorScreen } from '../screens/EditorScreen';
import { RootStackParamList } from '../types/navigation';

const Stack = createNativeStackNavigator<RootStackParamList>();

export const AppNavigator = () => {
    return (
        <Stack.Navigator>
            <Stack.Screen name="MainTabs" component={TabNavigator} options={{ headerShown: false }} />
            <Stack.Screen name="Preview" component={PreviewScreen} options={{ headerShown: false }} />
            <Stack.Screen name="Editor" component={EditorScreen} options={{ headerShown: false }} />
        </Stack.Navigator>
    );
};
