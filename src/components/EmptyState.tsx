import React from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { theme } from '../utils/theme';

interface EmptyStateProps {
    text: string;
}

export const EmptyState: React.FC<EmptyStateProps> = ({ text }) => {
    return (
        <View style={styles.emptyContainer}>
            <Text style={styles.emptyText}>{text}</Text>
        </View>
    );
};

const styles = StyleSheet.create({
    emptyContainer: {
        padding: theme.spacing.xl,
        alignItems: 'center',
        flex: 1, // Ensure it fills space if needed, though usually inside ListEmptyComponent it acts differently
    },
    emptyText: {
        color: theme.colors.textSecondary,
        fontSize: theme.typography.body.fontSize,
    },
});
