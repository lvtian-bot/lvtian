import React from 'react';
import { StyleSheet, TouchableOpacity } from 'react-native';
import Icon from '@expo/vector-icons/MaterialIcons';
import { theme } from '../utils/theme';

interface FabButtonProps {
    onPress: () => void;
    icon?: keyof typeof Icon.glyphMap;
    color?: string;
    backgroundColor?: string;
}

export const FabButton: React.FC<FabButtonProps> = ({
    onPress,
    icon = 'add',
    color = theme.colors.white,
    backgroundColor = theme.colors.primary
}) => {
    return (
        <TouchableOpacity
            style={[styles.fab, { backgroundColor }]}
            onPress={onPress}
        >
            <Icon name={icon} size={24} color={color} />
        </TouchableOpacity>
    );
};

const styles = StyleSheet.create({
    fab: {
        position: 'absolute',
        right: theme.spacing.lg,
        bottom: theme.spacing.lg,
        width: 56,
        height: 56,
        borderRadius: 28,
        justifyContent: 'center',
        alignItems: 'center',
        elevation: 4,
        shadowColor: theme.colors.black,
        shadowOffset: { width: 0, height: 2 },
        shadowOpacity: 0.25,
        shadowRadius: 4,
    },
});
