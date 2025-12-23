import React, { useState, useCallback, useLayoutEffect, useMemo } from 'react';
import { View, Text, StyleSheet, SectionList, TouchableOpacity, Alert, BackHandler } from 'react-native';
import { useFocusEffect, useNavigation } from '@react-navigation/native';
import Icon from '@expo/vector-icons/MaterialIcons';
import { useTranslation } from 'react-i18next';
import { theme } from '../utils/theme';
import { FlashNoteInputModal } from '../components/FlashNoteInputModal';
import { ActionSheetModal, ActionItem } from '../components/ActionSheetModal';
import { flashNoteService } from '../services/FlashNoteService';
import { TodoItem, Priority } from '../types/todo';
import { useFileMetadataStore } from '../store/useFileMetadataStore';

// Shared Components & Hooks
import { useFlashNoteList } from '../hooks/useFlashNoteList';
import { NoteListContainer, ListFooter, styles as containerStyles } from '../components/NoteListContainer';
import { StatusBannerContainer } from '../components/StatusBannerContainer';
import { FabButton } from '../components/FabButton';
import { EmptyState } from '../components/EmptyState';
import { HeaderSyncStatus } from '../components/HeaderSyncStatus';

type SectionData = {
    title: string | null;
    data: TodoItem[];
    type: 'in-progress' | 'todo' | 'done';
};

export const TodoScreen = () => {
    const navigation = useNavigation();
    const { t } = useTranslation();

    // Hook: Data & Sync Management
    const {
        data: allTodos,
        loading,
        refreshing,
        hasMore,
        handleLoadMore,
        handleRefresh,
        refreshLoadedData,
        syncStatus,
        conflictType,
        isSyncing,
        checkSync,
        resolveConflict,
        conflictedFiles,
        uploadErrorFiles
    } = useFlashNoteList<TodoItem>({
        parser: (content, filePath) => flashNoteService.extractTodos(flashNoteService.parseNotes(content, filePath)),
        // enableAutoCheck: false, // Removed
        sorter: undefined, // Todos are sorted by section logic, not simple sort
        initialLoadCount: 4
    });

    // Local State
    const [sections, setSections] = useState<SectionData[]>([]);
    const [doneItems, setDoneItems] = useState<TodoItem[]>([]);
    const [isDoneExpanded, setIsDoneExpanded] = useState(false);

    // UI Interaction State
    const [isModalVisible, setIsModalVisible] = useState(false);
    const [editingTodo, setEditingTodo] = useState<TodoItem | undefined>(undefined);

    // ActionSheet State
    const [isActionSheetVisible, setIsActionSheetVisible] = useState(false);
    const [selectedTodo, setSelectedTodo] = useState<TodoItem | undefined>(undefined);

    // Animation State
    const [completingItems, setCompletingItems] = useState<Set<string>>(new Set());

    // Sync Status Header
    const headerRight = useCallback(() => (
        <HeaderSyncStatus isSyncing={isSyncing} syncStatus={syncStatus} conflictType={conflictType} />
    ), [isSyncing, syncStatus, conflictType]);

    useLayoutEffect(() => {
        navigation.setOptions({
            headerRight: headerRight,
        });
    }, [navigation, headerRight]);

    // Metadata for Status Banner
    const fileMetadataStore = useFileMetadataStore();
    const hasFailedUpload = Object.values(fileMetadataStore.metadata).some(m => m.uploadState === 'failed');

    // Process Data into Sections
    useMemo(() => {
        if (!allTodos) return;

        const inProgress = allTodos.filter(item => item.status === 'in-progress');
        const todo = allTodos.filter(item => item.status === 'todo');
        const finished = allTodos
            .filter(item => item.status === 'done' || item.status === 'canceled')
            .sort((a, b) => b.noteId.localeCompare(a.noteId));

        const newSections: SectionData[] = [];
        if (inProgress.length > 0) {
            newSections.push({ title: t('todo.inProgress'), data: inProgress, type: 'in-progress' });
        }
        if (todo.length > 0) {
            newSections.push({ title: null, data: todo, type: 'todo' });
        }

        setSections(newSections);
        setDoneItems(finished);
    }, [allTodos, t]);

    // Back Handler
    useFocusEffect(useCallback(() => {
        const onBackPress = () => {
            BackHandler.exitApp();
            return true;
        };
        const subscription = BackHandler.addEventListener('hardwareBackPress', onBackPress);
        return () => subscription.remove();
    }, []));

    // -- Actions --

    const handleToggleStatus = async (item: TodoItem) => {
        const itemKey = `${item.noteId}-${item.rawLine}`;

        if (item.status === 'todo') {
            setCompletingItems(prev => new Set(prev).add(itemKey));
            setTimeout(async () => {
                try {
                    await flashNoteService.updateTodoStatus(item.noteId, item.rawLine, 'done', item.filePath);
                    refreshLoadedData();
                    setTimeout(() => {
                        setCompletingItems(prev => {
                            const next = new Set(prev);
                            next.delete(itemKey);
                            return next;
                        });
                    }, 100);
                } catch {
                    Alert.alert(t('common.error'), t('todo.updateStatusFailed'));
                    setCompletingItems(prev => {
                        const next = new Set(prev);
                        next.delete(itemKey);
                        return next;
                    });
                }
            }, 350);
        } else {
            try {
                await flashNoteService.updateTodoStatus(item.noteId, item.rawLine, 'todo', item.filePath);
                refreshLoadedData();
            } catch {
                Alert.alert(t('common.error'), t('todo.updateStatusFailed'));
            }
        }
    };

    const handleContentPress = (item: TodoItem) => {
        setEditingTodo(item);
        setIsModalVisible(true);
    };

    const handleSaveTodoContent = async (id: string | undefined, content: string) => {
        try {
            if (id && editingTodo) {
                await flashNoteService.updateTodoContent(editingTodo.noteId, editingTodo.rawLine, content, editingTodo.filePath);
            } else {
                const lines = content.split('\n').filter(line => line.trim().length > 0);
                if (lines.length === 0) return;
                const formattedContent = lines.map(line => `- [ ] ${line.trim()}`).join('\n');
                await flashNoteService.addNote(formattedContent);
            }
            setIsModalVisible(false);
            setEditingTodo(undefined);
            refreshLoadedData();
        } catch (error) {
            console.error('Failed to save todo content:', error);
            Alert.alert(t('common.error'), t('todo.updateContentFailed'));
        }
    };

    const handleLongPress = (item: TodoItem) => {
        setSelectedTodo(item);
        setIsActionSheetVisible(true);
    };

    const getActionSheetActions = (): ActionItem[] => {
        if (!selectedTodo) return [];
        return [
            {
                label: t('todo.setAsDone'),
                icon: 'check-box',
                onPress: () => flashNoteService.updateTodoStatus(selectedTodo.noteId, selectedTodo.rawLine, 'done', selectedTodo.filePath).then(refreshLoadedData),
                color: theme.colors.success,
            },
            {
                label: t('todo.setAsInProgress'),
                icon: 'hourglass-empty',
                onPress: () => flashNoteService.updateTodoStatus(selectedTodo.noteId, selectedTodo.rawLine, 'in-progress', selectedTodo.filePath).then(refreshLoadedData),
                color: theme.colors.primary,
            },
            {
                label: t('todo.setAsCanceled'),
                icon: 'indeterminate-check-box',
                onPress: () => flashNoteService.updateTodoStatus(selectedTodo.noteId, selectedTodo.rawLine, 'canceled', selectedTodo.filePath).then(refreshLoadedData),
                color: theme.colors.textSecondary,
            },
        ];
    };

    // -- Render --

    const getPriorityDisplay = (priority: Priority) => {
        switch (priority) {
            case 'highest': return { icon: 'error', label: t('priority.highest') || 'Highest', color: theme.colors.danger || '#F44336' };
            case 'high': return { icon: 'keyboard-double-arrow-up', label: t('priority.high') || 'High', color: theme.colors.orange || '#FF9800' };
            case 'medium': return { icon: 'keyboard-arrow-up', label: t('priority.medium') || 'Medium', color: theme.colors.warning || '#FFC107' };
            case 'low': return { icon: 'keyboard-arrow-down', label: t('priority.low') || 'Low', color: theme.colors.info || '#2196F3' };
            case 'lowest': return { icon: 'keyboard-double-arrow-down', label: t('priority.lowest') || 'Lowest', color: theme.colors.textSecondary || '#9E9E9E' };
            default: return null;
        }
    };

    const renderItem = ({ item }: { item: TodoItem }) => {
        const itemKey = `${item.noteId}-${item.rawLine}`;
        const isCompleting = completingItems.has(itemKey);

        let iconName = 'check-box-outline-blank';
        let iconColor = theme.colors.textSecondary;
        let textDecorationLine: 'none' | 'line-through' = 'none';
        let textColor = theme.colors.text;
        let fontSize = theme.typography.body.fontSize;

        if (isCompleting || item.status === 'done') {
            iconName = 'check-box';
            iconColor = theme.colors.success || '#4CAF50';
            textDecorationLine = 'line-through';
            textColor = theme.colors.textSecondary;
            fontSize = 14;
        } else if (item.status === 'in-progress') {
            iconName = 'hourglass-empty';
            iconColor = theme.colors.primary;
        } else if (item.status === 'canceled') {
            iconName = 'indeterminate-check-box';
            iconColor = theme.colors.textSecondary;
            textDecorationLine = 'line-through';
            textColor = theme.colors.textSecondary;
            fontSize = 14;
        }

        const priorityInfo = getPriorityDisplay(item.priority);

        return (
            <TouchableOpacity
                style={styles.itemContainer}
                onPress={() => handleContentPress(item)}
                onLongPress={() => handleLongPress(item)}
            >
                <Text style={styles.noteTime}>{item.noteId}</Text>
                <View style={styles.itemBody}>
                    <TouchableOpacity onPress={() => handleToggleStatus(item)} style={styles.iconContainer}>
                        <Icon name={iconName as any} size={24} color={iconColor} />
                    </TouchableOpacity>
                    <View style={styles.contentContainer}>
                        <Text style={[styles.itemText, { textDecorationLine, color: textColor, fontSize }]}>
                            {item.content}
                        </Text>
                        <View style={styles.metaRow}>
                            {priorityInfo && (
                                <View style={styles.priorityContainer}>
                                    <Icon name={priorityInfo.icon as any} size={14} color={priorityInfo.color} style={styles.metaIcon} />
                                    <Text style={[styles.metaText, { color: priorityInfo.color }]}>{priorityInfo.label}</Text>
                                </View>
                            )}
                            {item.dueAt && (
                                <View style={styles.dateContainer}>
                                    <Text style={styles.metaEmoji}>📅</Text>
                                    <Text style={styles.metaText}>{item.dueAt}</Text>
                                </View>
                            )}
                            {item.completedAt && (
                                <View style={styles.dateContainer}>
                                    <Text style={styles.metaEmoji}>✅</Text>
                                    <Text style={styles.metaText}>{item.completedAt}</Text>
                                </View>
                            )}
                            {item.canceledAt && (
                                <View style={styles.dateContainer}>
                                    <Text style={styles.metaEmoji}>❌</Text>
                                    <Text style={styles.metaText}>{item.canceledAt}</Text>
                                </View>
                            )}
                        </View>
                    </View>
                </View>
            </TouchableOpacity>
        );
    };

    const renderFooter = () => (
        <View>
            <ListFooter loading={loading} hasMore={hasMore} textEnd={t('todo.loadMoreHistoryTodos') || '-- No more todos --'} />

            {/* Done Section Logic */}
            {doneItems.length > 0 && (
                <View>
                    <TouchableOpacity
                        style={[styles.sectionHeader, styles.sectionHeaderDone]}
                        onPress={() => setIsDoneExpanded(!isDoneExpanded)}
                    >
                        <View style={styles.sectionHeaderDoneContent}>
                            <Icon name={isDoneExpanded ? 'keyboard-arrow-down' : 'keyboard-arrow-right'} size={24} color={theme.colors.textSecondary} />
                            <Text style={styles.sectionHeaderTextDone}>
                                {t('todo.finished')} ({doneItems.length})
                            </Text>
                        </View>
                    </TouchableOpacity>
                    {isDoneExpanded && doneItems.map((item, index) => (
                        <View key={`${item.noteId}-${index}`}>
                            {renderItem({ item })}
                        </View>
                    ))}
                </View>
            )}
        </View>
    );

    const renderSectionHeader = ({ section: { title } }: { section: SectionData }) => {
        if (!title) return null;
        return (
            <View style={styles.sectionHeader}>
                <Text style={styles.sectionHeaderText}>{title}</Text>
            </View>
        );
    };

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

            <SectionList
                sections={sections}
                keyExtractor={(item, index) => `${item.noteId}-${index}`}
                renderItem={renderItem}
                renderSectionHeader={renderSectionHeader}
                contentContainerStyle={containerStyles.listContent}
                stickySectionHeadersEnabled={false}
                ListFooterComponent={renderFooter}
                onEndReached={handleLoadMore}
                onEndReachedThreshold={0.5}
                refreshing={refreshing}
                onRefresh={handleRefresh}
                ListEmptyComponent={
                    !loading && sections.length === 0 ? <EmptyState text={t('todo.empty')} /> : null
                }
            />

            <FabButton
                icon="add"
                onPress={() => { setEditingTodo(undefined); setIsModalVisible(true); }}
            />

            <FlashNoteInputModal
                visible={isModalVisible}
                initialId={editingTodo?.id}
                initialContent={editingTodo?.content}
                initialPriority={editingTodo?.priority}
                initialDueAt={editingTodo?.dueAt}
                onSave={handleSaveTodoContent}
                onCancel={() => { setIsModalVisible(false); setEditingTodo(undefined); }}
                mode="todo"
            />

            <ActionSheetModal
                visible={isActionSheetVisible}
                title={selectedTodo?.content ? (selectedTodo.content.length > 30 ? selectedTodo.content.substring(0, 30) + '...' : selectedTodo.content) : undefined}
                actions={getActionSheetActions()}
                onCancel={() => {
                    setIsActionSheetVisible(false);
                    setSelectedTodo(undefined);
                }}
            />
        </NoteListContainer>
    );
};

const styles = StyleSheet.create({
    itemContainer: {
        flexDirection: 'column',
        alignItems: 'flex-start',
        padding: theme.spacing.m,
        backgroundColor: theme.colors.surface,
        borderRadius: theme.radius.sm,
        marginBottom: theme.spacing.s,
        shadowColor: '#000',
        shadowOffset: { width: 0, height: 1 },
        shadowOpacity: 0.03,
        shadowRadius: 4,
        elevation: 0.5,
    },
    itemBody: {
        flexDirection: 'row',
        alignItems: 'flex-start',
        width: '100%',
    },
    iconContainer: {
        marginRight: theme.spacing.m,
        marginTop: 2,
    },
    contentContainer: {
        flex: 1,
    },
    itemText: {
        lineHeight: 24,
    },
    noteTime: {
        fontSize: 14,
        color: theme.colors.textSecondary,
        marginBottom: 4,
    },
    sectionHeader: {
        backgroundColor: theme.colors.background,
        paddingVertical: theme.spacing.s,
        paddingHorizontal: theme.spacing.xs,
        marginTop: theme.spacing.m,
        marginBottom: theme.spacing.xs,
        borderLeftWidth: 4,
        borderLeftColor: theme.colors.primary,
    },
    sectionHeaderText: {
        fontSize: theme.typography.h3.fontSize,
        fontWeight: 'bold',
        color: theme.colors.text,
        paddingLeft: theme.spacing.xs,
    },
    sectionHeaderDone: {
        borderLeftWidth: 0,
        marginTop: theme.spacing.l,
        paddingLeft: 0,
        flexDirection: 'row',
        alignItems: 'center',
    },
    sectionHeaderDoneContent: {
        flexDirection: 'row',
        alignItems: 'center',
    },
    sectionHeaderTextDone: {
        fontSize: 14,
        color: theme.colors.textSecondary,
        fontWeight: 'normal',
        marginLeft: theme.spacing.xs,
    },
    metaRow: {
        flexDirection: 'row',
        alignItems: 'center',
        marginTop: 4,
    },
    metaIcon: {
        marginRight: 2,
    },
    dateContainer: {
        flexDirection: 'row',
        alignItems: 'center',
        marginRight: 8,
    },
    metaText: {
        fontSize: 12,
        color: theme.colors.textSecondary,
        marginLeft: 2,
    },
    metaEmoji: {
        fontSize: 12,
        marginRight: 2,
    },
    priorityContainer: {
        flexDirection: 'row',
        alignItems: 'center',
        marginRight: 8,
    },
});
