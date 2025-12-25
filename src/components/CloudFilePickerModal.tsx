import React, { useState, useEffect, useCallback } from 'react';
import {
    View,
    Text,
    StyleSheet,
    FlatList,
    Modal,
    TouchableOpacity,
    ActivityIndicator,
    Alert
} from 'react-native';
import { useTranslation } from 'react-i18next';
import Icon from '@expo/vector-icons/MaterialIcons';
import { theme } from '../utils/theme';
import { FileListItem } from './FileListItem';
import { Breadcrumb } from './Breadcrumb';
import { FileItem } from '../services/FileSystemService';
import { cloudService } from '../services/CloudService';
import { useFileListStore } from '../store/useFileListStore';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

type ExtendedFileItem = FileItem & { isCached?: boolean };

interface CloudFilePickerModalProps {
    visible: boolean;
    onClose: () => void;
    onSelectFile: (path: string) => void;
}

export const CloudFilePickerModal: React.FC<CloudFilePickerModalProps> = ({
    visible,
    onClose,
    onSelectFile
}) => {
    const { t } = useTranslation();
    const insets = useSafeAreaInsets();

    // State
    const [currentPath, setCurrentPath] = useState('');
    const [files, setFiles] = useState<ExtendedFileItem[]>([]);
    const [status, setStatus] = useState<'idle' | 'loading' | 'success' | 'error'>('idle');
    const [errorMessage, setErrorMessage] = useState('');

    const { getCachedList, setCachedList } = useFileListStore();

    // Reset path when modal opens
    useEffect(() => {
        if (visible) {
            setCurrentPath(''); // Start at root
            loadFiles('');
        }
    }, [visible]);

    const formatFileList = useCallback((list: any[]): ExtendedFileItem[] => {
        return list
            .filter(item => item && item.key)
            .map((item): ExtendedFileItem => ({
                name: item.key.endsWith('/')
                    ? item.key.split('/').slice(-2, -1)[0] + '/'
                    : item.key.split('/').pop() ?? item.key,
                path: item.key,
                size: item.size || 0,
                isDirectory: item.isDirectory ?? item.key.endsWith('/'),
                mtime: item.lastModified ? new Date(item.lastModified) : new Date(),
                isCached: true,
            }))
            .sort((a, b) => {
                if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1;
                return a.name.localeCompare(b.name);
            });
    }, []);

    const loadFiles = useCallback(async (prefix: string) => {
        setStatus('loading');
        setErrorMessage('');

        // 1. Try Cache First
        try {
            const cachedCloudFiles = getCachedList(prefix);
            if (cachedCloudFiles && cachedCloudFiles.length > 0) {
                setFiles(formatFileList(cachedCloudFiles));
            }
        } catch (e) {
            // Ignore cache error
        }

        // 2. Fetch Cloud
        try {
            if (!cloudService.isConfigured()) {
                setStatus('error');
                setErrorMessage(t('browser.unconfiguredMessage') || 'Cloud not configured');
                return;
            }

            const cloudFiles = await cloudService.listFiles(prefix);
            setCachedList(prefix, cloudFiles);
            setFiles(formatFileList(cloudFiles));
            setStatus('success');
        } catch (error: any) {
            // If we have cached files, treat as success (offline mode basically)
            const cached = getCachedList(prefix);
            if (cached && cached.length > 0) {
                setStatus('success');
                return;
            }

            console.error('Cloud load failed:', error);
            setStatus('error');
            setErrorMessage(error?.message || t('browser.error.default'));
        }
    }, [getCachedList, setCachedList, formatFileList, t]);

    const handleFilePress = (item: ExtendedFileItem) => {
        if (item.isDirectory) {
            const newPath = item.path;
            setCurrentPath(newPath);
            loadFiles(newPath);
        } else {
            // Only allow Markdown files
            if (item.name.toLowerCase().endsWith('.md')) {
                onSelectFile(item.path);
            } else {
                Alert.alert(t('common.info'), t('ai.onlyMarkdownSupport') || 'Only Markdown files are supported');
            }
        }
    };

    const handlePathPress = (path: string) => {
        setCurrentPath(path);
        loadFiles(path);
    };

    return (
        <Modal
            visible={visible}
            animationType="slide"
            presentationStyle="pageSheet"
            onRequestClose={onClose}
        >
            <View style={[styles.container, { paddingTop: insets.top }]}>
                {/* Header */}
                <View style={styles.header}>
                    <TouchableOpacity onPress={onClose} style={styles.closeButton}>
                        <Icon name="close" size={24} color={theme.colors.text} />
                    </TouchableOpacity>
                    <Text style={styles.title}>{t('common.selectFile') || 'Select File'}</Text>
                    <View style={styles.placeholder} />
                </View>

                {/* Breadcrumb */}
                <View style={styles.breadcrumbContainer}>
                    <Breadcrumb
                        path={currentPath}
                        onPathPress={handlePathPress}
                    />
                </View>

                {/* Content */}
                {status === 'loading' && files.length === 0 ? (
                    <View style={styles.centerContainer}>
                        <ActivityIndicator size="large" color={theme.colors.primary} />
                    </View>
                ) : status === 'error' && files.length === 0 ? (
                    <View style={styles.centerContainer}>
                        <Text style={styles.errorText}>{errorMessage}</Text>
                        <TouchableOpacity style={styles.retryButton} onPress={() => loadFiles(currentPath)}>
                            <Text style={styles.retryText}>{t('browser.retry')}</Text>
                        </TouchableOpacity>
                    </View>
                ) : (
                    <FlatList
                        data={files}
                        renderItem={({ item }) => (
                            <FileListItem
                                item={item}
                                onPress={handleFilePress}
                                isCached={true} // Simplify for modal
                            />
                        )}
                        keyExtractor={item => item.path}
                        contentContainerStyle={styles.listContent}
                        ListEmptyComponent={
                            <View style={styles.centerContainer}>
                                <Text style={styles.emptyText}>{t('browser.emptyMessage')}</Text>
                            </View>
                        }
                    />
                )}
            </View>
        </Modal>
    );
};

const styles = StyleSheet.create({
    container: {
        flex: 1,
        backgroundColor: theme.colors.background,
    },
    header: {
        flexDirection: 'row',
        alignItems: 'center',
        padding: theme.spacing.m,
        borderBottomWidth: 1,
        borderBottomColor: theme.colors.border,
        justifyContent: 'space-between',
    },
    closeButton: {
        padding: 4,
    },
    title: {
        fontSize: 18,
        fontWeight: 'bold',
        color: theme.colors.text,
    },
    placeholder: {
        width: 32,
    },
    breadcrumbContainer: {
        maxHeight: 50,
    },
    listContent: {
        paddingHorizontal: theme.spacing.s,
    },
    centerContainer: {
        flex: 1,
        justifyContent: 'center',
        alignItems: 'center',
        padding: theme.spacing.l,
    },
    errorText: {
        color: theme.colors.error,
        marginBottom: theme.spacing.m,
        textAlign: 'center',
    },
    emptyText: {
        color: theme.colors.textSecondary,
    },
    retryButton: {
        padding: theme.spacing.m,
        backgroundColor: theme.colors.surface,
        borderRadius: 8,
        borderWidth: 1,
        borderColor: theme.colors.border,
    },
    retryText: {
        color: theme.colors.primary,
    },
});
