import React from 'react';
import { Text, StyleSheet, TouchableOpacity, ActivityIndicator } from 'react-native';
import MaterialCommunityIcons from '@expo/vector-icons/MaterialCommunityIcons';
import { type ComponentProps } from 'react';
import { theme } from '../../utils/theme';

interface SettingsPrimaryButtonProps {
    label: string;
    onPress: () => void;
    loading?: boolean;
    disabled?: boolean;
    icon?: ComponentProps<typeof MaterialCommunityIcons>['name'];
}

export const SettingsPrimaryButton: React.FC<SettingsPrimaryButtonProps> = ({
    label,
    onPress,
    loading,
    disabled,
    icon,
}) => {
    return (
        <TouchableOpacity
            style={[styles.button, (loading || disabled) && styles.buttonDisabled]}
            onPress={onPress}
            activeOpacity={0.8}
            disabled={loading || disabled}
        >
            {loading ? (
                <ActivityIndicator size="small" color={theme.colors.white} />
            ) : (
                <>
                    {icon ? (
                        <MaterialCommunityIcons
                            name={icon}
                            size={17}
                            color={theme.colors.white}
                            style={styles.icon}
                        />
                    ) : null}
                    <Text style={styles.text}>{label}</Text>
                </>
            )}
        </TouchableOpacity>
    );
};

const styles = StyleSheet.create({
    button: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'center',
        backgroundColor: theme.colors.primaryDark,
        borderRadius: 13,
        paddingVertical: 13,
        marginHorizontal: 20,
        marginTop: 16,
        shadowColor: theme.colors.primaryDark,
        shadowOffset: { width: 0, height: 6 },
        shadowOpacity: 0.35,
        shadowRadius: 12,
        elevation: 4,
    },
    buttonDisabled: {
        opacity: 0.55,
    },
    icon: {
        marginRight: 7,
    },
    text: {
        fontSize: 15,
        fontWeight: '600',
        color: theme.colors.white,
    },
});
