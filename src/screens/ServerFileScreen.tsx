import React, { useState, useCallback, useEffect, useRef } from 'react';
import {
    View,
    Text,
    StyleSheet,
    FlatList,
    RefreshControl,
    ActivityIndicator,
    TouchableOpacity,
    Alert,
    BackHandler,
} from 'react-native';
import { useNavigation, useFocusEffect } from '@react-navigation/native';
import { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { useTranslation } from 'react-i18next';
import Icon from '@expo/vector-icons/MaterialIcons';
import * as Sharing from 'expo-sharing';
import * as FileSystem from 'expo-file-system/legacy';

import { theme } from '../utils/theme';
import { RootStackParamList, NoteStackParamList } from '../types/navigation';
import { serverFileService } from '../services/ServerFileService';
import { ServerFileItem, FileSystemInfo } from '../types/assistantProtocol';
import { useAssistantStore } from '../store/useAssistantStore';

type NavigationProp = NativeStackNavigationProp<RootStackParamList & NoteStackParamList>;

const TEXT_EXTENSIONS = new Set([
    '.md',
    '.markdown',
    '.txt',
    '.json',
    '.js',
    '.ts',
    '.html',
    '.css',
    '.yaml',
    '.yml',
    '.sh',
    '.log',
    '.xml',
    '.csv',
]);

const MAX_PREVIEW_SIZE = 5 * 1024 * 1024; // 5MB

interface HeaderCloudButtonProps {
    onPress: () => void;
    label: string;
}

const HeaderCloudButton: React.FC<HeaderCloudButtonProps> = ({ onPress, label }) => (
    <TouchableOpacity
        style={styles.headerRightButton}
        onPress={onPress}
        activeOpacity={0.7}
    >
        <Icon name="cloud-queue" size={20} color={theme.colors.primary} />
        <Text style={styles.headerRightText}>{label}</Text>
    </TouchableOpacity>
);

export const ServerFileScreen = () => {
    const { t } = useTranslation();
    const navigation = useNavigation<NavigationProp>();

    const { serverUrl } = useAssistantStore();
    const isConfigured = !!serverUrl && serverUrl.trim().length > 0;

    const [currentPath, setCurrentPath] = useState<string>('');
    const [parentPath, setParentPath] = useState<string | null>(null);
    const [items, setItems] = useState<ServerFileItem[]>([]);
    const [systemInfo, setSystemInfo] = useState<FileSystemInfo | null>(null);
    const [loading, setLoading] = useState<boolean>(false);
    const [refreshing, setRefreshing] = useState<boolean>(false);
    const [errorMessage, setErrorMessage] = useState<string | null>(null);
    const [downloadingItem, setDownloadingItem] = useState<string | null>(null);

    const currentPathRef = useRef<string>('');
    const parentPathRef = useRef<string | null>(null);
    const hasLoadedInitialRef = useRef<boolean>(false);
    const prevServerUrl = useRef(serverUrl);
    const requestIdRef = useRef<number>(0);

    useEffect(() => {
        if (prevServerUrl.current !== serverUrl) {
            prevServerUrl.current = serverUrl;
            setCurrentPath('');
            setParentPath(null);
            currentPathRef.current = '';
            parentPathRef.current = null;
            hasLoadedInitialRef.current = false;
            setSystemInfo(null);
            setItems([]);
        }
    }, [serverUrl]);

    const handleOpenCloud = useCallback(() => {
        navigation.navigate('CloudFileList');
    }, [navigation]);

    const renderHeaderRight = useCallback(
        () => <HeaderCloudButton onPress={handleOpenCloud} label={t('browser.cloudRepo', { defaultValue: '云盘' })} />,
        [handleOpenCloud, t]
    );

    // 设置导航栏右上角按钮：跳转到纯在线云盘文件页面
    useEffect(() => {
        navigation.setOptions({
            headerRight: renderHeaderRight,
        });
    }, [navigation, renderHeaderRight]);

    /**
     * 加载指定目录或初始化主目录
     */
    const loadDirectory = useCallback(
        async (targetPath?: string, isRefresh: boolean = false) => {
            if (!isConfigured) {
                setErrorMessage(t('assistant.unconfigured', { defaultValue: '尚未配置个人助理服务' }));
                return;
            }

            const requestId = ++requestIdRef.current;

            if (isRefresh) {
                setRefreshing(true);
            } else {
                setLoading(true);
            }
            setErrorMessage(null);

            try {
                // 如果尚未获取系统信息，先行获取
                let currentSysInfo = systemInfo;
                if (!currentSysInfo) {
                    currentSysInfo = await serverFileService.getSystemInfo();
                    if (requestId !== requestIdRef.current) return;
                    setSystemInfo(currentSysInfo);
                }

                // 首次进入默认打开主目录
                const pathToLoad = targetPath !== undefined ? targetPath : (currentPathRef.current || currentSysInfo.homeDir);
                const listing = await serverFileService.listDirectory(pathToLoad);
                if (requestId !== requestIdRef.current) return;

                setCurrentPath(listing.currentPath);
                setParentPath(listing.parentPath);
                currentPathRef.current = listing.currentPath;
                parentPathRef.current = listing.parentPath;
                hasLoadedInitialRef.current = true;
                setItems(listing.items);
            } catch (err: unknown) {
                if (requestId !== requestIdRef.current) return;
                const serverErr = err as { code?: string; message?: string };
                const code = serverErr.code;
                let message = (err as Error).message || '读取目录失败';
                if (code) {
                    message = t(`browser.error.${code}`, { defaultValue: message });
                }
                setErrorMessage(message);
            } finally {
                if (requestId === requestIdRef.current) {
                    setLoading(false);
                    setRefreshing(false);
                }
            }
        },
        [isConfigured, systemInfo, t]
    );

    useFocusEffect(
        useCallback(() => {
            if (isConfigured) {
                if (!hasLoadedInitialRef.current) {
                    loadDirectory(undefined);
                }
            }

            // 仅在当前屏幕获焦时监听 Android 返回键：如果在子目录，先返回上级
            const backAction = () => {
                if (parentPathRef.current !== null) {
                    loadDirectory(parentPathRef.current);
                    return true;
                }
                return false;
            };

            const backHandler = BackHandler.addEventListener('hardwareBackPress', backAction);
            return () => backHandler.remove();
        }, [isConfigured, loadDirectory])
    );

    /**
     * 点击单个文件或文件夹
     */
    const handleItemPress = (item: ServerFileItem) => {
        if (item.isDirectory) {
            loadDirectory(item.path);
            return;
        }

        const ext = item.extension.toLowerCase();
        const isSupportedText = TEXT_EXTENSIONS.has(ext);

        if (isSupportedText && item.size <= MAX_PREVIEW_SIZE) {
            // 支持文本/Markdown 预览与轻度编辑
            navigation.navigate('Preview', {
                filePath: item.path,
                source: 'server',
                title: item.name,
            });
        } else {
            // 非文本类型或超过 5MB 的超大文本文件提示下载并打开
            const promptMessage = isSupportedText && item.size > MAX_PREVIEW_SIZE
                ? t('browser.oversizedPreviewPrompt', {
                    defaultValue: '该文件体积超过 5MB 无法直接文本预览，是否下载并调起系统应用打开？',
                })
                : t('browser.unsupportedPreviewPrompt', {
                    defaultValue: '该文件类型无法直接文本预览，是否下载并调起系统应用打开？',
                });

            Alert.alert(
                item.name,
                promptMessage,
                [
                    { text: t('common.cancel', { defaultValue: '取消' }), style: 'cancel' },
                    { text: t('common.download', { defaultValue: '下载并打开' }), onPress: () => handleDownloadAndOpen(item) },
                ]
            );
        }
    };

    /**
     * 下载文件并调起系统分享
     */
    const handleDownloadAndOpen = async (item: ServerFileItem) => {
        if (downloadingItem) return;
        setDownloadingItem(item.path);

        try {
            const cacheDir = FileSystem.cacheDirectory || '';
            const tempLocalUri = `${cacheDir}server_${Date.now()}_${item.name}`;

            await serverFileService.downloadFile(item.path, tempLocalUri);

            const isAvailable = await Sharing.isAvailableAsync();
            if (isAvailable) {
                await Sharing.shareAsync(tempLocalUri);
            } else {
                Alert.alert(t('common.tip', { defaultValue: '提示' }), t('browser.shareUnavailable', { defaultValue: '当前设备不支持分享打开该文件' }));
            }
        } catch (err: unknown) {
            const serverErr = err as { code?: string; message?: string };
            const code = serverErr.code;
            let message = (err as Error).message || '下载文件失败';
            if (code) {
                message = t(`browser.error.${code}`, { defaultValue: message });
            }
            Alert.alert(t('common.error', { defaultValue: '错误' }), message);
        } finally {
            setDownloadingItem(null);
        }
    };

    /**
     * 格式化文件修改时间
     */
    const formatTime = (timestamp: number) => {
        if (!timestamp) return '-';
        const d = new Date(timestamp);
        if (isNaN(d.getTime())) return '-';
        const pad = (n: number) => n.toString().padStart(2, '0');
        return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
    };

    /**
     * 渲染单行条目
     */
    const renderItem = ({ item }: { item: ServerFileItem }) => {
        const isDir = item.isDirectory;
        const iconName = isDir ? 'folder' : 'description';
        const iconColor = isDir ? theme.colors.primary : theme.colors.textSecondary;
        const isDownloading = downloadingItem === item.path;

        return (
            <TouchableOpacity
                style={styles.itemContainer}
                onPress={() => handleItemPress(item)}
                onLongPress={() => {
                    if (!isDir) {
                        handleDownloadAndOpen(item);
                    }
                }}
                activeOpacity={0.65}
            >
                <View style={styles.iconContainer}>
                    {isDownloading ? (
                        <ActivityIndicator size="small" color={theme.colors.primary} />
                    ) : (
                        <Icon name={iconName} size={28} color={iconColor} />
                    )}
                </View>
                <View style={styles.contentContainer}>
                    <Text style={styles.itemName} numberOfLines={1}>
                        {item.name}
                    </Text>
                    <Text style={styles.itemDetails}>
                        {isDir ? t('fileItem.folder', { defaultValue: '文件夹' }) : `${(item.size / 1024).toFixed(1)} KB`}{' '}
                        • {formatTime(item.mtime)}
                    </Text>
                </View>
                <Icon name="chevron-right" size={20} color={theme.colors.border} />
            </TouchableOpacity>
        );
    };

    // 未配置状态
    if (!isConfigured) {
        return (
            <View style={styles.centerContainer}>
                <Icon name="dns" size={48} color={theme.colors.textSecondary} />
                <Text style={styles.messageTitle}>{t('assistant.unconfiguredTitle', { defaultValue: '未连接助手服务' })}</Text>
                <Text style={styles.messageText}>
                    {t('assistant.unconfiguredDesc', { defaultValue: '请先配置绿天独立服务端连接，即可浏览并获取 VPS 上的工作成果。' })}
                </Text>
                <TouchableOpacity
                    style={styles.primaryButton}
                    onPress={() => navigation.navigate('AssistantConfig')}
                    activeOpacity={0.7}
                >
                    <Text style={styles.primaryButtonText}>{t('assistant.goToConfig', { defaultValue: '前往配置' })}</Text>
                </TouchableOpacity>
            </View>
        );
    }

    return (
        <View style={styles.container}>
            {/* 顶部路径条与返回上级操作 */}
            <View style={styles.pathBar}>
                <TouchableOpacity
                    style={[styles.backParentButton, !parentPath && styles.disabledButton]}
                    onPress={() => parentPath && loadDirectory(parentPath)}
                    disabled={!parentPath}
                >
                    <Icon name="arrow-upward" size={20} color={parentPath ? theme.colors.primary : theme.colors.border} />
                    <Text style={[styles.backParentText, !parentPath && styles.disabledText]}>
                        {t('browser.parentDir', { defaultValue: '上一级' })}
                    </Text>
                </TouchableOpacity>
                <View style={styles.pathTextWrapper}>
                    <Text style={styles.pathText} numberOfLines={1} ellipsizeMode="middle">
                        {currentPath || systemInfo?.homeDir || '/'}
                    </Text>
                </View>
            </View>

            {/* 错误提示条 */}
            {errorMessage && (
                <View style={styles.errorBanner}>
                    <Icon name="error-outline" size={18} color="#d32f2f" />
                    <Text style={styles.errorBannerText} numberOfLines={2}>
                        {errorMessage}
                    </Text>
                    <TouchableOpacity onPress={() => loadDirectory(currentPath, false)}>
                        <Text style={styles.retryText}>{t('common.retry', { defaultValue: '重试' })}</Text>
                    </TouchableOpacity>
                </View>
            )}

            {/* 内容列表 */}
            {loading && !refreshing ? (
                <View style={styles.centerContainer}>
                    <ActivityIndicator size="large" color={theme.colors.primary} />
                    <Text style={styles.loadingText}>{t('common.loading', { defaultValue: '加载中...' })}</Text>
                </View>
            ) : (
                <FlatList
                    data={items}
                    keyExtractor={(item) => item.path}
                    renderItem={renderItem}
                    contentContainerStyle={items.length === 0 ? styles.emptyListContent : styles.listContent}
                    refreshControl={
                        <RefreshControl
                            refreshing={refreshing}
                            onRefresh={() => loadDirectory(currentPath, true)}
                            colors={[theme.colors.primary]}
                        />
                    }
                    ListEmptyComponent={
                        !errorMessage ? (
                            <View style={styles.emptyContainer}>
                                <Icon name="folder-open" size={48} color={theme.colors.border} />
                                <Text style={styles.emptyText}>{t('browser.emptyDirectory', { defaultValue: '此目录下暂无文件' })}</Text>
                            </View>
                        ) : null
                    }
                />
            )}
        </View>
    );
};

const styles = StyleSheet.create({
    container: {
        flex: 1,
        backgroundColor: theme.colors.background,
    },
    headerRightButton: {
        flexDirection: 'row',
        alignItems: 'center',
        paddingHorizontal: 12,
        paddingVertical: 6,
        marginRight: 8,
        borderRadius: 16,
        backgroundColor: '#eef4ff',
        gap: 4,
    },
    headerRightText: {
        fontSize: 13,
        fontWeight: '600',
        color: theme.colors.primary,
    },
    pathBar: {
        flexDirection: 'row',
        alignItems: 'center',
        paddingHorizontal: 12,
        paddingVertical: 10,
        backgroundColor: theme.colors.surface,
        borderBottomWidth: 1,
        borderBottomColor: '#f0f0f0',
        gap: 8,
    },
    backParentButton: {
        flexDirection: 'row',
        alignItems: 'center',
        paddingHorizontal: 8,
        paddingVertical: 4,
        borderRadius: 6,
        backgroundColor: '#f5f5f5',
        gap: 2,
    },
    disabledButton: {
        backgroundColor: '#fafafa',
    },
    backParentText: {
        fontSize: 12,
        color: theme.colors.primary,
        fontWeight: '500',
    },
    disabledText: {
        color: theme.colors.border,
    },
    pathTextWrapper: {
        flex: 1,
    },
    pathText: {
        fontSize: 12,
        color: theme.colors.textSecondary,
        fontFamily: 'monospace',
    },
    errorBanner: {
        flexDirection: 'row',
        alignItems: 'center',
        backgroundColor: '#ffebee',
        paddingHorizontal: 16,
        paddingVertical: 8,
        gap: 8,
    },
    errorBannerText: {
        flex: 1,
        fontSize: 12,
        color: '#d32f2f',
    },
    retryText: {
        fontSize: 12,
        fontWeight: 'bold',
        color: '#d32f2f',
        paddingHorizontal: 8,
        paddingVertical: 4,
    },
    listContent: {
        paddingVertical: 4,
    },
    emptyListContent: {
        flex: 1,
    },
    itemContainer: {
        flexDirection: 'row',
        alignItems: 'center',
        paddingHorizontal: 16,
        paddingVertical: 12,
        backgroundColor: theme.colors.surface,
        borderBottomWidth: 1,
        borderBottomColor: '#f4f4f4',
    },
    iconContainer: {
        marginRight: 12,
        width: 32,
        alignItems: 'center',
    },
    contentContainer: {
        flex: 1,
    },
    itemName: {
        fontSize: 15,
        fontWeight: '500',
        color: theme.colors.text,
        marginBottom: 2,
    },
    itemDetails: {
        fontSize: 12,
        color: theme.colors.textSecondary,
    },
    centerContainer: {
        flex: 1,
        justifyContent: 'center',
        alignItems: 'center',
        padding: 24,
    },
    emptyContainer: {
        flex: 1,
        justifyContent: 'center',
        alignItems: 'center',
        paddingTop: 80,
    },
    emptyText: {
        marginTop: 12,
        fontSize: 14,
        color: theme.colors.textSecondary,
    },
    loadingText: {
        marginTop: 12,
        fontSize: 14,
        color: theme.colors.textSecondary,
    },
    messageTitle: {
        fontSize: 18,
        fontWeight: 'bold',
        color: theme.colors.text,
        marginTop: 16,
        marginBottom: 8,
    },
    messageText: {
        fontSize: 14,
        color: theme.colors.textSecondary,
        textAlign: 'center',
        lineHeight: 20,
        marginBottom: 24,
    },
    primaryButton: {
        backgroundColor: theme.colors.primary,
        paddingHorizontal: 20,
        paddingVertical: 10,
        borderRadius: 8,
    },
    primaryButtonText: {
        color: '#fff',
        fontSize: 14,
        fontWeight: '600',
    },
});
