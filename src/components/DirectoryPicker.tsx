import React, { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import {
    Modal,
    View,
    Text,
    TouchableOpacity,
    StyleSheet,
    FlatList,
    ActivityIndicator,
} from 'react-native';
import Icon from '@expo/vector-icons/MaterialIcons';
import { theme } from '../utils/theme';
import { FileItem, fsService } from '../services/FileSystemService';
import { cloudService } from '../services/CloudService';

interface DirectoryPickerProps {
    visible: boolean;
    currentPath: string;
    onConfirm: (selectedPath: string) => void;
    onCancel: () => void;
}

export const DirectoryPicker: React.FC<DirectoryPickerProps> = ({
    visible,
    currentPath,
    onConfirm,
    onCancel,
}) => {
    const { t } = useTranslation();
    const [currentDir, setCurrentDir] = useState('');
    const [directories, setDirectories] = useState<FileItem[]>([]);
    const [loading, setLoading] = useState(false);

    useEffect(() => {
        if (visible) {
            // 初始化时显示根目录
            const parentPath = currentPath.split('/').slice(0, -1).join('/');
            setCurrentDir(parentPath);
            loadDirectories(parentPath);
        }
    }, [visible, currentPath]);

    const loadDirectories = async (path: string) => {
        setLoading(true);
        try {
            // 尝试从云端获取目录列表
            if (cloudService.isConfigured()) {
                const files = await cloudService.listFiles(path);
                const dirs = files
                    .filter(f => f.key.endsWith('/'))
                    .map(f => ({
                        name: f.key.split('/').slice(-2, -1)[0] + '/',
                        path: f.key,
                        size: 0,
                        isDirectory: true,
                        mtime: new Date(f.lastModified),
                    }));
                setDirectories(dirs);
            } else {
                // 如果未配置云端，则使用本地文件系统
                const files = await fsService.listFiles(path);
                const dirs = files.filter(f => f.isDirectory);
                setDirectories(dirs);
            }
        } catch (error) {
            console.error('Failed to load directories:', error);
            setDirectories([]);
        } finally {
            setLoading(false);
        }
    };

    const handleDirPress = (dir: FileItem) => {
        setCurrentDir(dir.path);
        loadDirectories(dir.path);
    };

    const handleBack = () => {
        const parts = currentDir.split('/').filter(Boolean);
        parts.pop();
        const parentDir = parts.length > 0 ? parts.join('/') + '/' : '';
        setCurrentDir(parentDir);
        loadDirectories(parentDir);
    };

    const handleConfirm = () => {
        onConfirm(currentDir);
    };

    const renderBreadcrumb = () => {
        if (!currentDir) {
            return <Text style={styles.breadcrumb}>{t('browser.root')}</Text>;
        }
        const parts = currentDir.split('/').filter(Boolean);
        return (
            <Text style={styles.breadcrumb}>
                {parts.length > 0 ? parts.join(' / ') : t('browser.root')}
            </Text>
        );
    };

    return (
        <Modal
            animationType="slide"
            transparent={false}
            visible={visible}
            onRequestClose={onCancel}
        >
            <View style={styles.container}>
                <View style={styles.header}>
                    <TouchableOpacity onPress={onCancel} style={styles.headerButton}>
                        <Text style={styles.headerButtonText}>{t('common.cancel')}</Text>
                    </TouchableOpacity>
                    <Text style={styles.headerTitle}>{t('browser.selectTargetDir')}</Text>
                    <TouchableOpacity onPress={handleConfirm} style={styles.headerButton}>
                        <Text style={[styles.headerButtonText, styles.confirmText]}>{t('common.confirm')}</Text>
                    </TouchableOpacity>
                </View>

                <View style={styles.breadcrumbContainer}>
                    {currentDir && (
                        <TouchableOpacity onPress={handleBack} style={styles.backButton}>
                            <Icon name="arrow-back" size={20} color={theme.colors.primary} />
                        </TouchableOpacity>
                    )}
                    {renderBreadcrumb()}
                </View>

                <View style={styles.currentDirInfo}>
                    <Text style={styles.infoText}>{t('browser.currentDir')}</Text>
                </View>

                {loading ? (
                    <ActivityIndicator size="large" style={styles.loader} />
                ) : (
                    <FlatList
                        data={directories}
                        renderItem={({ item }) => (
                            <TouchableOpacity
                                style={styles.dirItem}
                                onPress={() => handleDirPress(item)}
                            >
                                <Icon name="folder" size={24} color={theme.colors.primary} />
                                <Text style={styles.dirName}>{item.name}</Text>
                                <Icon name="chevron-right" size={24} color={theme.colors.textSecondary} />
                            </TouchableOpacity>
                        )}
                        keyExtractor={(item) => item.path}
                        ListEmptyComponent={
                            <View style={styles.emptyContainer}>
                                <Text style={styles.emptyText}>{t('browser.emptyDir')}</Text>
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
        justifyContent: 'space-between',
        alignItems: 'center',
        padding: theme.spacing.m,
        borderBottomWidth: 1,
        borderBottomColor: theme.colors.border,
        backgroundColor: theme.colors.surface,
    },
    headerButton: {
        padding: theme.spacing.s,
        minWidth: 60,
    },
    headerButtonText: {
        fontSize: 16,
        color: theme.colors.textSecondary,
    },
    confirmText: {
        color: theme.colors.primary,
        fontWeight: '600',
        textAlign: 'right',
    },
    headerTitle: {
        fontSize: 18,
        fontWeight: '600',
        color: theme.colors.text,
    },
    breadcrumbContainer: {
        flexDirection: 'row',
        alignItems: 'center',
        padding: theme.spacing.m,
        backgroundColor: theme.colors.surface,
        borderBottomWidth: 1,
        borderBottomColor: theme.colors.border,
    },
    backButton: {
        marginRight: theme.spacing.s,
    },
    breadcrumb: {
        flex: 1,
        fontSize: 14,
        color: theme.colors.textSecondary,
    },
    currentDirInfo: {
        padding: theme.spacing.m,
        backgroundColor: '#E8F5E9',
        borderBottomWidth: 1,
        borderBottomColor: theme.colors.border,
    },
    infoText: {
        fontSize: 14,
        color: '#2E7D32',
        textAlign: 'center',
    },
    loader: {
        flex: 1,
        justifyContent: 'center',
        alignItems: 'center',
    },
    dirItem: {
        flexDirection: 'row',
        alignItems: 'center',
        padding: theme.spacing.m,
        borderBottomWidth: 1,
        borderBottomColor: theme.colors.border,
        backgroundColor: theme.colors.surface,
    },
    dirName: {
        flex: 1,
        fontSize: 16,
        color: theme.colors.text,
        marginLeft: theme.spacing.m,
    },
    emptyContainer: {
        padding: theme.spacing.xl,
        alignItems: 'center',
    },
    emptyText: {
        fontSize: 14,
        color: theme.colors.textSecondary,
    },
});
