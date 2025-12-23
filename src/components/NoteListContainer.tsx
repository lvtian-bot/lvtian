import React from 'react';
import { View, StyleSheet, ActivityIndicator } from 'react-native';
import { theme } from '../utils/theme';

interface NoteListContainerProps {
    children: React.ReactNode;
}

export const NoteListContainer: React.FC<NoteListContainerProps> = ({ children }) => {
    return (
        <View style={styles.container}>
            {children}
        </View>
    );
};

interface ListFooterProps {
    loading: boolean;
    hasMore: boolean;
    textEnd?: string;
    onLoadMore?: () => void; // Optional if we want to make the text clickable or just visual
}

export const ListFooter: React.FC<ListFooterProps> = ({ loading, hasMore, textEnd = '-- End --' }) => {
    if (!loading && !hasMore) {
        return (
            <View style={styles.footer}>
                <Text style={styles.footerText}>{textEnd}</Text>
            </View>
        );
    }
    if (loading) {
        return (
            <View style={styles.footer}>
                <ActivityIndicator size="small" color={theme.colors.primary} />
            </View>
        );
    }
    return null;
};

import { Text } from 'react-native';

export const styles = StyleSheet.create({
    container: {
        flex: 1,
        backgroundColor: theme.colors.background,
    },
    listContent: {
        paddingHorizontal: theme.spacing.sm, // Standardized as 8
        paddingTop: theme.spacing.md,
        paddingBottom: 80, // Space for FAB
    },
    footer: {
        paddingVertical: 20,
        alignItems: 'center',
        justifyContent: 'center',
    },
    footerText: {
        color: theme.colors.textSecondary,
        fontSize: 14,
    },
});
