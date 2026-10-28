import React, { useState } from 'react';
import { View, Text, StyleSheet, TextInput, TouchableOpacity } from 'react-native';
import MaterialCommunityIcons from '@expo/vector-icons/MaterialCommunityIcons';
import { theme } from '../../utils/theme';
import { useSettingsFont } from './useSettingsFont';
import { auxFontSizes } from '../../utils/fontSize';

interface SettingsFieldInputProps {
    label: string;
    value: string;
    onChangeText: (text: string) => void;
    placeholder?: string;
    secure?: boolean;
    hint?: string;
}

export const SettingsFieldInput: React.FC<SettingsFieldInputProps> = ({
    label,
    value,
    onChangeText,
    placeholder,
    secure,
    hint,
}) => {
    const [focused, setFocused] = useState(false);
    const [revealed, setRevealed] = useState(false);
    const font = useSettingsFont();

    return (
        <View style={styles.wrap}>
            <Text style={styles.label}>{label}</Text>
            <View
                style={[
                    styles.inputWrap,
                    focused && styles.inputWrapFocused,
                ]}
            >
                <TextInput
                    style={[styles.input, { fontSize: font.chatBody }]}
                    value={value}
                    onChangeText={onChangeText}
                    placeholder={placeholder}
                    placeholderTextColor={theme.colors.textSecondary}
                    secureTextEntry={secure && !revealed}
                    autoCapitalize="none"
                    autoCorrect={false}
                    onFocus={() => setFocused(true)}
                    onBlur={() => setFocused(false)}
                />
                {secure ? (
                    <TouchableOpacity
                        style={styles.eye}
                        onPress={() => setRevealed(!revealed)}
                        hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                    >
                        <MaterialCommunityIcons
                            name={revealed ? 'eye-off' : 'eye'}
                            size={17}
                            color={theme.colors.textTertiary}
                        />
                    </TouchableOpacity>
                ) : null}
            </View>
            {hint ? <Text style={styles.hint}>{hint}</Text> : null}
        </View>
    );
};

const styles = StyleSheet.create({
    wrap: {
        paddingHorizontal: 20,
        marginTop: 6,
    },
    label: {
        fontSize: auxFontSizes.secondary,
        fontWeight: '500',
        color: theme.colors.text,
        marginBottom: 6,
    },
    inputWrap: {
        flexDirection: 'row',
        alignItems: 'center',
        backgroundColor: theme.colors.inputBg,
        borderWidth: 1,
        borderColor: theme.colors.border,
        borderRadius: 10,
    },
    inputWrapFocused: {
        borderColor: theme.colors.primary,
        backgroundColor: theme.colors.surface,
    },
    input: {
        flex: 1,
        paddingHorizontal: 12,
        paddingVertical: 10,
        color: theme.colors.text,
    },
    eye: {
        padding: 8,
    },
    hint: {
        fontSize: auxFontSizes.caption,
        color: theme.colors.textTertiary,
        marginTop: 5,
    },
});
