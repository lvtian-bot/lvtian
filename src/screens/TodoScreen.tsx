import React, { useState, useCallback, useEffect } from 'react';
import { View, Text, StyleSheet, SectionList, TouchableOpacity, Alert, ActivityIndicator } from 'react-native';
import { useFocusEffect } from '@react-navigation/native';
import Icon from 'react-native-vector-icons/MaterialIcons';
import { flashNoteService, FLASH_NOTES_UPDATED_EVENT, TodoItem, TodoStatus } from '../services/FlashNoteService';
import { fsService } from '../services/FileSystemService';
import { useSettingsStore } from '../store/useSettingsStore';
import { theme } from '../utils/theme';
import { DeviceEventEmitter } from 'react-native';
import { useTranslation } from 'react-i18next';
import { FlashNoteInputModal } from '../components/FlashNoteInputModal';
import { ActionSheetModal, ActionItem } from '../components/ActionSheetModal';
import { useCloudSync } from '../hooks/useCloudSync';
import { HeaderSyncStatus } from '../components/HeaderSyncStatus';
import { useNavigation } from '@react-navigation/native';

type SectionData = {
    title: string | null;
    data: TodoItem[];
    type: 'in-progress' | 'todo' | 'done';
};

const INITIAL_LOAD_COUNT = 3; // 1 Main + 2 History
const PAGE_SIZE = 3;

// ... existing code ...

export const TodoScreen = () => {
    const [sections, setSections] = useState<SectionData[]>([]);
    const [doneItems, setDoneItems] = useState<TodoItem[]>([]); // Separate state for done items
    const [isDoneExpanded, setIsDoneExpanded] = useState(false); // State for collapsing done section
    const [loading, setLoading] = useState(false);
    const [loadedCount, setLoadedCount] = useState(INITIAL_LOAD_COUNT);
    const [hasMore, setHasMore] = useState(false);
    const [syncTargetPaths, setSyncTargetPaths] = useState<string[]>([]); // Track files for sync
    const { t } = useTranslation();

    const navigation = useNavigation(); // Get navigation object

    useSettingsStore(); // Subscribe to changes

    const [isModalVisible, setIsModalVisible] = useState(false);
    const [editingTodo, setEditingTodo] = useState<TodoItem | undefined>(undefined);

    // ActionSheet state
    const [isActionSheetVisible, setIsActionSheetVisible] = useState(false);
    const [selectedTodo, setSelectedTodo] = useState<TodoItem | undefined>(undefined);

    // Use the multi-file sync hook
    const { syncStatus, conflictType, isSyncing, performAutoSync } = useCloudSync(syncTargetPaths);

    // Update header with sync status
    React.useLayoutEffect(() => {
        navigation.setOptions({
            headerRight: () => (
                <HeaderSyncStatus isSyncing={isSyncing} syncStatus={syncStatus} conflictType={conflictType} />
            ),
        });
    }, [navigation, isSyncing, syncStatus, conflictType]);

    // Trigger sync when targets change (e.g. initial load or load more)
    useEffect(() => {
        if (syncTargetPaths.length > 0) {
            performAutoSync();
        }
    }, [syncTargetPaths, performAutoSync]);

    const loadTodos = useCallback(async () => {
        setLoading(true);
        try {
            const allFilePaths = await flashNoteService.getSortedFilePaths();
            setHasMore(loadedCount < allFilePaths.length);

            const targetPaths = allFilePaths.slice(0, loadedCount);
            setSyncTargetPaths(targetPaths); // Update sync targets

            let allTodos: TodoItem[] = [];

            const results = await Promise.all(targetPaths.map(async (path) => {
                try {
                    if (await fsService.exists(path)) {
                        const content = await fsService.readFile(path);
                        const notes = flashNoteService.parseNotes(content, path);
                        return flashNoteService.extractTodos(notes);
                    }
                } catch (e) {
                    console.error(`Error reading file ${path}:`, e);
                }
                return [];
            }));

            allTodos = results.flat();

            const inProgress = allTodos.filter(item => item.status === 'in-progress');
            const todo = allTodos.filter(item => item.status === 'todo');

            // Combine done and canceled for the bottom section, then sort by noteId (time) descending
            const finished = allTodos
                .filter(item => item.status === 'done' || item.status === 'canceled')
                .sort((a, b) => b.noteId.localeCompare(a.noteId));

            const newSections: SectionData[] = [];

            // 1. In Progress (First)
            if (inProgress.length > 0) {
                newSections.push({ title: t('todo.inProgress'), data: inProgress, type: 'in-progress' });
            }
            // 2. Todo (Second)
            if (todo.length > 0) {
                newSections.push({ title: null, data: todo, type: 'todo' });
            }

            setSections(newSections);
            setDoneItems(finished); // Set done items separately

        } catch (error) {
            console.error('Failed to load todos:', error);
        } finally {
            setLoading(false);
        }
    }, [t, loadedCount]);

    useFocusEffect(useCallback(() => {
        loadTodos();
    }, [loadTodos]));

    useEffect(() => {
        const subscription = DeviceEventEmitter.addListener(FLASH_NOTES_UPDATED_EVENT, () => {
            loadTodos();
        });
        return () => subscription.remove();
    }, [loadTodos]);

    const handleLoadMore = () => {
        setLoadedCount(prev => prev + PAGE_SIZE);
    };

    useEffect(() => {
        if (loadedCount > INITIAL_LOAD_COUNT) {
            loadTodos();
        }
    }, [loadedCount, loadTodos]);



    const handleToggleStatus = async (item: TodoItem) => {
        let newStatus: TodoStatus;
        if (item.status === 'todo') {
            newStatus = 'done'; // 未完成 -> 已完成
        } else {
            newStatus = 'todo'; // 其他所有状态 (已完成, 进行中, 已取消) -> 未完成
        }

        try {
            await flashNoteService.updateTodoStatus(item.noteId, item.rawLine, newStatus, item.filePath);
        } catch {
            Alert.alert(t('common.error'), t('todo.updateStatusFailed'));
        }
    };

    const handleContentPress = (item: TodoItem) => {
        setEditingTodo(item);
        setIsModalVisible(true);
    };

    const handleSaveTodoContent = async (id: string | undefined, content: string) => {
        if (!editingTodo) return;
        try {
            await flashNoteService.updateTodoContent(editingTodo.noteId, editingTodo.rawLine, content, editingTodo.filePath);
            setIsModalVisible(false);
            setEditingTodo(undefined);
        } catch (error) {
            console.error('Failed to update todo content:', error);
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
                onPress: () => flashNoteService.updateTodoStatus(selectedTodo.noteId, selectedTodo.rawLine, 'done', selectedTodo.filePath),
                color: theme.colors.success,
            },
            {
                label: t('todo.setAsInProgress'),
                icon: 'hourglass-empty',
                onPress: () => flashNoteService.updateTodoStatus(selectedTodo.noteId, selectedTodo.rawLine, 'in-progress', selectedTodo.filePath),
                color: theme.colors.primary,
            },
            {
                label: t('todo.setAsCanceled'),
                icon: 'indeterminate-check-box',
                onPress: () => flashNoteService.updateTodoStatus(selectedTodo.noteId, selectedTodo.rawLine, 'canceled', selectedTodo.filePath),
                color: theme.colors.textSecondary,
            },
            // Future expansion: Priority setting, Date picking, etc.
        ];
    };

    const renderItem = ({ item }: { item: TodoItem }) => {
        let iconName = 'check-box-outline-blank';
        let iconColor = theme.colors.textSecondary;
        let textDecorationLine: 'none' | 'line-through' = 'none';
        let textColor = theme.colors.text;
        let fontSize = theme.typography.body.fontSize;

        switch (item.status) {
            case 'done':
                iconName = 'check-box';
                iconColor = theme.colors.success || '#4CAF50';
                textDecorationLine = 'line-through';
                textColor = theme.colors.textSecondary;
                fontSize = 14; // Smaller font for done
                break;
            case 'in-progress':
                iconName = 'hourglass-empty';
                iconColor = theme.colors.primary;
                break;
            case 'canceled':
                iconName = 'indeterminate-check-box';
                iconColor = theme.colors.textSecondary;
                textDecorationLine = 'line-through';
                textColor = theme.colors.textSecondary;
                fontSize = 14; // Smaller font for canceled
                break;
        }

        return (
            <View style={styles.itemContainer}>
                <TouchableOpacity onPress={() => handleToggleStatus(item)} style={styles.iconContainer}>
                    <Icon name={iconName} size={24} color={iconColor} />
                </TouchableOpacity>

                <TouchableOpacity
                    style={styles.contentContainer}
                    onPress={() => handleContentPress(item)}
                    onLongPress={() => handleLongPress(item)}
                >
                    <Text style={[styles.itemText, { textDecorationLine, color: textColor, fontSize }]}>
                        {item.content}
                    </Text>
                    <Text style={styles.noteTime}>{item.noteId}</Text>
                </TouchableOpacity>
            </View>
        );
    };

    const renderSectionHeader = ({ section: { title, type } }: { section: SectionData }) => {
        if (!title) return null; // Hide header for Todo

        return (
            <View style={styles.sectionHeader}>
                <Text style={styles.sectionHeaderText}>{title}</Text>
            </View>
        );
    };

    const renderFooter = () => {
        return (
            <View>
                {/* 1. Load More Button */}
                {hasMore && (
                    <TouchableOpacity
                        style={styles.loadMoreButton}
                        onPress={handleLoadMore}
                        disabled={loading}
                    >
                        {loading ? (
                            <ActivityIndicator color={theme.colors.primary} />
                        ) : (
                            <Text style={styles.loadMoreText}>{t('todo.loadMoreHistoryTodos')}</Text>
                        )}
                    </TouchableOpacity>
                )}

                {/* 2. Done Section Header */}
                {doneItems.length > 0 && (
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
                )}

                {/* 3. Done Items List */}
                {isDoneExpanded && doneItems.map(item => (
                    <View key={item.id}>
                        {renderItem({ item })}
                    </View>
                ))}
            </View>
        );
    };

    return (
        <View style={styles.container}>
            <SectionList
                sections={sections}
                keyExtractor={(item) => item.id}
                renderItem={renderItem}
                renderSectionHeader={renderSectionHeader}
                contentContainerStyle={styles.listContent}
                stickySectionHeadersEnabled={false}
                ListFooterComponent={renderFooter}
                ListEmptyComponent={
                    !loading && sections.length === 0 ? (
                        <View style={styles.emptyContainer}>
                            <Text style={styles.emptyText}>{t('todo.empty')}</Text>
                        </View>
                    ) : null
                }
            />

            <FlashNoteInputModal
                visible={isModalVisible}
                initialId={editingTodo?.id} // Use unique ID to manage draft keys
                initialContent={editingTodo?.content}
                onSave={handleSaveTodoContent}
                onCancel={() => { setIsModalVisible(false); setEditingTodo(undefined); }}
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
        </View>
    );
};

const styles = StyleSheet.create({
    container: {
        flex: 1,
        backgroundColor: theme.colors.background,
    },
    listContent: {
        paddingBottom: 20,
        paddingHorizontal: theme.spacing.m,
        paddingTop: theme.spacing.m,
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
    sectionHeaderDone: {
        borderLeftWidth: 0, // Remove left border for Done
        marginTop: theme.spacing.l,
        paddingLeft: 0, // Remove extra padding since no border
        flexDirection: 'row',
        alignItems: 'center',
    },
    sectionHeaderText: {
        fontSize: theme.typography.h3.fontSize,
        fontWeight: 'bold',
        color: theme.colors.text,
        paddingLeft: theme.spacing.xs,
    },
    sectionHeaderTextDone: {
        fontSize: 14, // Smaller font for Done header
        color: theme.colors.textSecondary,
        fontWeight: 'normal',
        marginLeft: theme.spacing.xs,
    },
    itemContainer: {
        flexDirection: 'row',
        alignItems: 'flex-start',
        padding: theme.spacing.m,
        backgroundColor: theme.colors.surface,
        borderRadius: 8,
        marginBottom: theme.spacing.s,
        marginHorizontal: theme.spacing.xs,
        shadowColor: '#000',
        shadowOffset: { width: 0, height: 1 },
        shadowOpacity: 0.20,
        shadowRadius: 1.41,
        elevation: 2,
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
        fontSize: 10,
        color: theme.colors.textSecondary,
        marginTop: 2,
    },
    emptyContainer: {
        padding: theme.spacing.xl,
        alignItems: 'center',
    },
    emptyText: {
        color: theme.colors.textSecondary,
        fontSize: theme.typography.body.fontSize,
    },
    loadMoreButton: {
        padding: theme.spacing.m,
        alignItems: 'center',
        justifyContent: 'center',
        marginTop: theme.spacing.s,
        marginBottom: theme.spacing.s,
    },
    loadMoreText: {
        color: theme.colors.primary,
        fontSize: 14,
    },
    sectionHeaderDoneContent: {
        flexDirection: 'row',
        alignItems: 'center',
    },
});