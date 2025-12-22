import React from 'react';
import { View, Text, StyleSheet, TouchableOpacity, ViewStyle } from 'react-native';
import { theme } from '../utils/theme';

interface StatusBannerProps {
    visible: boolean;
    message: string;
    type?: 'warning' | 'info' | 'error';
    onPress?: () => void;
    style?: ViewStyle;
    actions?: Array<{
        label: string;
        onPress: () => void;
    }>;
}

export const StatusBanner: React.FC<StatusBannerProps> = ({
    visible,
    message,
    type = 'warning',
    onPress,
    style,
    actions
}) => {
    if (!visible) return null;

    const getColors = () => {
        switch (type) {
            case 'info':
                return { bg: '#D1ECF1', text: '#0C5460', border: '#BEE5EB' };
            case 'error':
                return { bg: '#F8D7DA', text: '#721C24', border: '#F5C6CB' };
            case 'warning':
            default:
                return { bg: '#FFF3CD', text: '#856404', border: '#FFEEBA' };
        }
    };

    const colors = getColors();

    const Content = (
        <View style={[
            styles.container,
            {
                backgroundColor: colors.bg,
                borderBottomColor: colors.border
            },
            style
        ]}>
            <Text style={[styles.text, { color: colors.text }]}>
                {message}
            </Text>
            {actions && actions.length > 0 && (
                <View style={styles.actionsContainer}>
                    {actions.map((action, index) => (
                        <TouchableOpacity
                            key={index}
                            style={[styles.actionButton, { backgroundColor: colors.border }]}
                            onPress={action.onPress}
                        >
                            <Text style={[styles.actionText, { color: colors.text }]}>{action.label}</Text>
                        </TouchableOpacity>
                    ))}
                </View>
            )}
        </View>
    );

    if (onPress && (!actions || actions.length === 0)) {
        return (
            <TouchableOpacity onPress={onPress}>
                {Content}
            </TouchableOpacity>
        );
    }

    return Content;
};

const styles = StyleSheet.create({
    container: {
        padding: 8, // Matching NoteScreen padding
        alignItems: 'center', // Matching NoteScreen alignment
        borderBottomWidth: 1,
        width: '100%',
    },
    text: {
        fontSize: 12, // Matching NoteScreen fontSize
        textAlign: 'center',
    },
    actionsContainer: {
        flexDirection: 'row',
        flexWrap: 'wrap',
        justifyContent: 'center',
        marginTop: 8,
    },
    actionButton: {
        paddingHorizontal: 12,
        paddingVertical: 4,
        borderRadius: 4,
        marginHorizontal: 4,
        marginBottom: 4,
    },
    actionText: {
        fontSize: 12,
        fontWeight: 'bold',
    }
});
