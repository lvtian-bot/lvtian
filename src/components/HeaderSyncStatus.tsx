import React from 'react';
import { View, Text, ActivityIndicator, StyleSheet } from 'react-native';
import { theme } from '../utils/theme';
import { SyncStatus, ConflictType } from '../services/SyncService';

interface HeaderSyncStatusProps {
    isSyncing: boolean;
    syncStatus: SyncStatus;
    conflictType: ConflictType;
}

export const HeaderSyncStatus: React.FC<HeaderSyncStatusProps> = ({ isSyncing, syncStatus, conflictType }) => {
    const isEffectivelySyncing = isSyncing ||
        syncStatus === 'checking' ||
        (syncStatus === 'conflict' && (conflictType === 'cloudNewer' || conflictType === 'localNewer'));

    return (
        <View style={styles.headerRight}>
            {isEffectivelySyncing && <ActivityIndicator size="small" color={theme.colors.primary} />}

            {!isEffectivelySyncing && syncStatus === 'synced' && <Text style={styles.syncIcon}>✅</Text>}

            {!isEffectivelySyncing && (syncStatus === 'conflict' || syncStatus === 'offline') && <Text style={styles.syncIcon}>⚠️</Text>}

            {!isEffectivelySyncing && syncStatus === 'not-configured' && <Text style={styles.syncIcon}>ℹ️</Text>}
        </View>
    );
};

const styles = StyleSheet.create({
    headerRight: {
        flexDirection: 'row',
        alignItems: 'center',
        marginRight: theme.spacing.md,
    },
    syncIcon: {
        fontSize: 16,
        marginLeft: theme.spacing.sm,
        color: theme.colors.text, // Ensure text color is defined
    },
});
