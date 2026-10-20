import React, { useState, useCallback, useLayoutEffect } from 'react';
import { View, Text, StyleSheet, FlatList, TouchableOpacity, Alert, Clipboard, BackHandler, Share } from 'react-native';
import { useNavigation, useFocusEffect } from '@react-navigation/native';
import Icon from '@expo/vector-icons/MaterialIcons';
import { theme } from '../utils/theme';
import { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { RootStackParamList } from '../types/navigation';
import { useTranslation } from 'react-i18next';
import { useFileMetadataStore } from '../store/useFileMetadataStore';
import { FlashNoteInputModal } from '../components/FlashNoteInputModal';
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
        prependLocal,
        updateLocalById,
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

    const [isModalVisible, setIsModalVisible] = useState(false);
    const [editingNoteId, setEditingNoteId] = useState<string | undefined>(undefined);
    const [editingNoteContent, setEditingNoteContent] = useState<string | undefined>(undefined);

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
            <TouchableOpacity
                onPress={() => (navigation as any).navigate('Me')}
                hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}
                style={styles.settingsButton}
                activeOpacity={0.7}
            >
                <Icon name="settings" size={22} color={theme.colors.textSecondary} />
            </TouchableOpacity>
        </View>
    ), [isSyncing, syncStatus, conflictType, navigation]);

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
        // Direct jump to Editor for existing notes
        navigation.navigate('Editor', {
            filePath: 'flash_note.md', // Dummy path
            flashNoteId: note.id,
            initialContent: note.content.trim()
        });
    };

    const handleSaveFlashNote = async (id: string | undefined, content: string) => {
        setIsModalVisible(false);
        try {
            if (id) {
                const updated = await flashNoteService.updateNote(id, content);
                updateLocalById(id, updated);
            } else {
                const created = await flashNoteService.addNote(content);
                if (created) prependLocal(created);
            }
        } catch (error) {
            console.error('Failed to save flash note', error);
            Alert.alert(t('common.error'), t('timeline.saveError'));
            refreshLoadedData();
        }
    };

    const handleCancelFlashNote = () => {
        setIsModalVisible(false);
        setEditingNoteId(undefined);
        setEditingNoteContent(undefined);
    };

    const handleExpandFlashNote = (content: string) => {
        setIsModalVisible(false);
        // Navigate to Editor Screen with content mode
        // Note: filePath is dummy but required by types, flashNoteId triggers the mode
        navigation.navigate('Editor', {
            filePath: 'flash_note.md',
            flashNoteId: editingNoteId || 'new',
            initialContent: content
        });

        // Reset local state as we offloaded to Editor
        setEditingNoteId(undefined);
        setEditingNoteContent(undefined);
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
                <Text style={styles.timestamp}>{item.timestamp}</Text>
                <Text style={styles.content} numberOfLines={5} ellipsizeMode="tail">{item.content.trim()}</Text>
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
                onPress={() => { setEditingNoteId(undefined); setEditingNoteContent(undefined); setIsModalVisible(true); }}
            />

            <FlashNoteInputModal
                visible={isModalVisible}
                initialId={editingNoteId}
                initialContent={editingNoteContent}
                onSave={handleSaveFlashNote}
                onCancel={handleCancelFlashNote}
                onExpand={handleExpandFlashNote}
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
    settingsButton: {
        marginLeft: 12,
        marginRight: 8,
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
        fontSize: 16,
        color: theme.colors.text,
        lineHeight: 24,
    },
});
