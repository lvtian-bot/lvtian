import React, { useState, useCallback, useLayoutEffect } from 'react';
import { View, Text, StyleSheet, FlatList, TouchableOpacity, Alert, Clipboard, BackHandler, Share } from 'react-native';
import { useNavigation, useFocusEffect } from '@react-navigation/native';
import { theme } from '../utils/theme';
import { formatNoteTimestamp } from '../utils/formatNoteTime';
import { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { RootStackParamList } from '../types/navigation';
import { useTranslation } from 'react-i18next';
import { useFileMetadataStore } from '../store/useFileMetadataStore';
import { useSettingsStore } from '../store/useSettingsStore';
import { getFontSizeMetrics } from '../utils/fontSize';
import { flashNoteService, FlashNote } from '../services/FlashNoteService';
import { ActionSheetModal, ActionItem } from '../components/ActionSheetModal';

// Shared Components & Hooks
import { useFlashNoteList } from '../hooks/useFlashNoteList';
import { NoteListContainer, ListFooter, styles as containerStyles } from '../components/NoteListContainer';
import { StatusBannerContainer } from '../components/StatusBannerContainer';
import { FabButton } from '../components/FabButton';
import { HeaderSyncStatus } from '../components/HeaderSyncStatus';

type FlashScreenNavigationProp = NativeStackNavigationProp<RootStackParamList>;

export const FlashScreen = () => {
    const navigation = useNavigation<FlashScreenNavigationProp>();
    const { t } = useTranslation();
    const { fontSize } = useSettingsStore();
    const metrics = getFontSizeMetrics(fontSize);

    // Hook: Data & Sync Management
    const {
        data: notes,
        loading,
        refreshing,
        hasMore,
        handleLoadMore,
        handleRefresh,
        refreshLoadedData,
        removeLocalById,
        syncStatus,
        conflictType,
        isSyncing,
        checkSync,
        resolveConflict,
        conflictedFiles,
        uploadErrorFiles
    } = useFlashNoteList<FlashNote>({
        parser: (content, filePath) => flashNoteService.parseNotes(content, filePath),
        // enableAutoCheck: true, // Removed
        sorter: (a, b) => b.timestamp.localeCompare(a.timestamp)
    });

    // ActionSheet state
    const [isActionSheetVisible, setIsActionSheetVisible] = useState(false);
    const [selectedNote, setSelectedNote] = useState<FlashNote | null>(null);

    // Get metadata for upload status check (simplistic check on first/current file could be improved)
    // For general status banner, we might check if ANY file failed.
    const fileMetadataStore = useFileMetadataStore();
    // Simple check: do we have any failed uploads in the store?
    const hasFailedUpload = Object.values(fileMetadataStore.metadata).some(m => m.uploadState === 'failed' || m.uploadState === 'conflict-failed');

    const headerRight = useCallback(() => (
        <View style={styles.headerRightContainer}>
            <HeaderSyncStatus isSyncing={isSyncing} syncStatus={syncStatus} conflictType={conflictType} />
        </View>
    ), [isSyncing, syncStatus, conflictType]);

    useLayoutEffect(() => {
        navigation.setOptions({
            headerRight: headerRight,
        });
    }, [navigation, headerRight]);

    useFocusEffect(useCallback(() => {
        const onBackPress = () => {
            BackHandler.exitApp();
            return true;
        };
        const subscription = BackHandler.addEventListener('hardwareBackPress', onBackPress);

        // Check sync on focus (with service-level cooldown)
        checkSync();

        return () => subscription.remove();
    }, [checkSync]));

    // -- Action Handlers --

    const handleEditNote = (note: FlashNote) => {
        navigation.navigate('FlashNoteEditor', {
            flashNoteId: note.id,
            noteFilePath: note.filePath,
            initialContent: note.content,
        });
    };

    const handleDeleteFlashNote = async (noteToDelete: FlashNote) => {
        Alert.alert(
            t('common.confirm'),
            t('browser.confirmDelete', { fileName: noteToDelete.id }),
            [
                { text: t('common.cancel'), style: 'cancel' },
                {
                    text: t('common.confirm'),
                    onPress: async () => {
                        removeLocalById(noteToDelete.id);
                        try {
                            await flashNoteService.deleteNote(noteToDelete.id);
                        } catch (error) {
                            console.error('Failed to delete flash note:', error);
                            Alert.alert(t('common.error'), t('timeline.deleteError'));
                            refreshLoadedData();
                        }
                    },
                },
            ]
        );
    };

    const handleNoteLongPress = (item: FlashNote) => {
        setSelectedNote(item);
        setIsActionSheetVisible(true);
    };

    const getActionSheetActions = (): ActionItem[] => {
        if (!selectedNote) return [];
        return [
            {
                label: t('common.copy'),
                icon: 'content-copy',
                onPress: () => {
                    Clipboard.setString(selectedNote.content.trim());
                    Alert.alert(t('common.notice'), t('common.copiedToClipboard'));
                },
            },
            {
                label: t('common.share'),
                icon: 'share',
                onPress: async () => {
                    try {
                        await Share.share({
                            message: selectedNote.content,
                        });
                    } catch (error) {
                        Alert.alert(t('common.error'), String(error));
                    }
                },
            },
            {
                label: t('common.edit'),
                icon: 'edit',
                onPress: () => handleEditNote(selectedNote),
            },
            {
                label: t('common.delete'),
                icon: 'delete',
                onPress: () => handleDeleteFlashNote(selectedNote),
                destructive: true,
            },
        ];
    };

    // -- Render --

    const renderItem = ({ item }: { item: FlashNote }) => (
        <View style={styles.card}>
            <TouchableOpacity
                onPress={() => handleEditNote(item)}
                onLongPress={() => handleNoteLongPress(item)}
            >
                <Text style={styles.timestamp}>{formatNoteTimestamp(item.timestamp, t)}</Text>
                <Text
                    style={[
                        styles.content,
                        {
                            fontSize: metrics.flashBody,
                            lineHeight: metrics.flashLineHeight,
                        },
                    ]}
                    numberOfLines={5}
                    ellipsizeMode="tail"
                >
                    {item.content.trim()}
                </Text>
            </TouchableOpacity>
        </View>
    );

    return (
        <NoteListContainer>
            <StatusBannerContainer
                syncStatus={syncStatus}
                conflictType={conflictType}
                checkSync={checkSync}
                hasFailedUpload={hasFailedUpload}
                conflictedFiles={conflictedFiles}
                uploadErrorFiles={uploadErrorFiles}
                onResolveUseCloud={() => resolveConflict('useCloud').then(handleRefresh)}
                onResolveUseLocal={() => resolveConflict('useLocal').then(handleRefresh)}
                onResolveSaveCopy={() => resolveConflict('saveCopy').then(handleRefresh)}
            />

            <FlatList
                data={notes}
                renderItem={renderItem}
                keyExtractor={(item, index) => `${item.id}-${index}`}
                contentContainerStyle={containerStyles.listContent}
                onEndReached={handleLoadMore}
                onEndReachedThreshold={0.5}
                ListFooterComponent={<ListFooter loading={loading} hasMore={hasMore} textEnd="-- End of Timeline --" />}
                refreshing={refreshing}
                onRefresh={handleRefresh}
            />

            <FabButton
                icon="flash-on"
                onPress={() => navigation.navigate('FlashNoteEditor', { flashNoteId: 'new' })}
            />

            <ActionSheetModal
                visible={isActionSheetVisible}
                title={selectedNote?.content ? (selectedNote.content.length > 30 ? selectedNote.content.substring(0, 30) + '...' : selectedNote.content) : undefined}
                actions={getActionSheetActions()}
                onCancel={() => {
                    setIsActionSheetVisible(false);
                    setSelectedNote(null);
                }}
            />
        </NoteListContainer >
    );
};

const styles = StyleSheet.create({
    headerRightContainer: {
        flexDirection: 'row',
        alignItems: 'center',
    },
    card: {
        backgroundColor: theme.colors.surface,
        borderRadius: theme.radius.sm,
        padding: theme.spacing.md,
        marginBottom: theme.spacing.sm,
        shadowColor: theme.colors.black,
        shadowOffset: { width: 0, height: 1 },
        shadowOpacity: 0.03,
        shadowRadius: 4,
        elevation: 0.5,
    },
    timestamp: {
        fontSize: 14,
        color: theme.colors.mutedText,
        marginBottom: theme.spacing.xs,
    },
    content: {
        color: theme.colors.text,
    },
});
