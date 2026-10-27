import React, { useCallback, useEffect, useRef, useState } from 'react';
import { View, Text, StyleSheet } from 'react-native';
import MaterialCommunityIcons from '@expo/vector-icons/MaterialCommunityIcons';
import { theme } from '../../utils/theme';

interface SettingsToastApi {
    toast: string | null;
    showToast: (message: string) => void;
}

/** 设置页轻提示：替代系统 Alert 的成功/结果反馈 */
export function useSettingsToast(): SettingsToastApi {
    const [toast, setToast] = useState<string | null>(null);
    const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

    const showToast = useCallback((message: string) => {
        if (timerRef.current) {
            clearTimeout(timerRef.current);
        }
        setToast(message);
        timerRef.current = setTimeout(() => setToast(null), 2200);
    }, []);

    useEffect(() => {
        return () => {
            if (timerRef.current) {
                clearTimeout(timerRef.current);
            }
        };
    }, []);

    return { toast, showToast };
}

export const SettingsToast: React.FC<{ message: string | null }> = ({ message }) => {
    if (!message) return null;
    return (
        <View style={styles.wrap} pointerEvents="none">
            <View style={styles.toast}>
                <MaterialCommunityIcons name="check-circle" size={15} color="#6EE7B7" />
                <Text style={styles.text}>{message}</Text>
            </View>
        </View>
    );
};

const styles = StyleSheet.create({
    wrap: {
        position: 'absolute',
        top: 56,
        left: 0,
        right: 0,
        alignItems: 'center',
    },
    toast: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 7,
        backgroundColor: 'rgba(31, 41, 51, 0.92)',
        borderRadius: 999,
        paddingHorizontal: 15,
        paddingVertical: 9,
        shadowColor: '#000',
        shadowOffset: { width: 0, height: 4 },
        shadowOpacity: 0.2,
        shadowRadius: 10,
        elevation: 6,
    },
    text: {
        fontSize: 13,
        color: theme.colors.white,
    },
});
