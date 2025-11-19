import React from 'react';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { TabNavigator } from './TabNavigator';
import { EditorScreen } from '../screens/EditorScreen';
import { NewFlashNoteScreen } from '../screens/NewFlashNoteScreen';
import { RootStackParamList } from '../types/navigation';

const Stack = createNativeStackNavigator<RootStackParamList>();

export const AppNavigator = () => {
    return (
        <Stack.Navigator>
            <Stack.Screen name="MainTabs" component={TabNavigator} options={{ headerShown: false }} />
            <Stack.Screen name="Editor" component={EditorScreen} options={{ headerShown: false }} />
            <Stack.Screen name="NewFlashNote" component={NewFlashNoteScreen} options={{ title: 'New Flash Note' }} />
        </Stack.Navigator>
    );
};
