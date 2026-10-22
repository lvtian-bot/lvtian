import React, { useState, useCallback, useEffect, useRef } from 'react';
import {
    View,
    Text,
    StyleSheet,
    FlatList,
    RefreshControl,
    ActivityIndicator,
    TouchableOpacity,
    BackHandler,
    DeviceEventEmitter,
    Alert,
} from 'react-native';
import { useNavigation, useFocusEffect, useRoute, RouteProp } from '@react-navigation/native';
import { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { useTranslation } from 'react-i18next';
import Icon from '@expo/vector-icons/MaterialIcons';

import { theme } from '../utils/theme';
import { RootStackParamList, NoteStackParamList } from '../types/navigation';
import { cloudService, CLOUD_INIT_COMPLETED_EVENT } from '../services/CloudService';

type NavigationProp = NativeStackNavigationProp<RootStackParamList & NoteStackParamList>;
type RoutePropType = RouteProp<NoteStackParamList, 'CloudFileList'>;

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

interface DisplayItem {
    name: string;
    key: string;
    isDirectory: boolean;
    size: number;
    lastModified: string;
}

export const CloudNoteScreen = () => {
    const { t } = useTranslation();
    const navigation = useNavigation<NavigationProp>();
    const route = useRoute<RoutePropType>();

    const [currentPrefix, setCurrentPrefix] = useState<string>(route.params?.prefix || '');
    const [items, setItems] = useState<DisplayItem[]>([]);
    const [loading, setLoading] = useState<boolean>(false);
    const [refreshing, setRefreshing] = useState<boolean>(false);
    const [errorMessage, setErrorMessage] = useState<string | null>(null);
    const [isConfigured, setIsConfigured] = useState<boolean>(cloudService.isConfigured());
    const requestIdRef = useRef<number>(0);

    // 监听云存储初始化完成事件，确保非响应式的 SecureStore 异步读取完成后及时更新界面
    useEffect(() => {
        const checkConfig = () => {
            setIsConfigured(cloudService.isConfigured());
        };
        const sub = DeviceEventEmitter.addListener(CLOUD_INIT_COMPLETED_EVENT, checkConfig);
        checkConfig();
        return () => sub.remove();
    }, []);

    /**
     * 在线拉取云盘文件并提取当前目录层级
     */
    const loadCloudFiles = useCallback(
        async (isRefresh = false) => {
            if (!cloudService.isConfigured()) {
                setErrorMessage(t('browser.unconfigured', { defaultValue: '未配置网盘服务' }));
                return;
            }

            const reqId = ++requestIdRef.current;

            if (isRefresh) {
                setRefreshing(true);
            } else {
                setLoading(true);
            }
            setErrorMessage(null);

            try {
                // 直接向 WebDAV 请求云端文件列表（纯在线）
                const rawFiles = await cloudService.listFiles(currentPrefix);

                if (reqId !== requestIdRef.current) {
                    // 已有更新的请求发出，忽略过期结果
                    return;
                }

                // 组织当前目录层级的条目
                const map = new Map<string, DisplayItem>();
                const normalizedPrefix = currentPrefix ? (currentPrefix.endsWith('/') ? currentPrefix : `${currentPrefix}/`) : '';

                for (const file of rawFiles) {
                    const key = file.key;
                    if (!key.startsWith(normalizedPrefix)) continue;
                    const relative = key.slice(normalizedPrefix.length);
                    if (!relative || relative === '/') continue;

                    const slashIdx = relative.indexOf('/');
                    if (slashIdx !== -1) {
                        // 属于子文件夹
                        const dirName = relative.slice(0, slashIdx);
                        const dirKey = `${normalizedPrefix}${dirName}/`;
                        if (!map.has(dirName)) {
                            map.set(dirName, {
                                name: dirName,
                                key: dirKey,
                                isDirectory: true,
                                size: 0,
                                lastModified: file.lastModified,
                            });
                        }
                    } else {
                        // 属于当前目录的直接文件
                        map.set(relative, {
                            name: relative,
                            key: file.key,
                            isDirectory: !!file.isDirectory,
                            size: file.size || 0,
                            lastModified: file.lastModified,
                        });
                    }
                }

                const displayList = Array.from(map.values());
                // 排序：文件夹在前，文件在后
                displayList.sort((a, b) => {
                    if (a.isDirectory && !b.isDirectory) return -1;
                    if (!a.isDirectory && b.isDirectory) return 1;
                    return a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' });
                });

                setItems(displayList);
            } catch (err: unknown) {
                if (reqId === requestIdRef.current) {
                    const message = (err as Error).message || '连接网盘失败，请检查网络';
                    setErrorMessage(message);
                }
            } finally {
                if (reqId === requestIdRef.current) {
                    setLoading(false);
                    setRefreshing(false);
                }
            }
        },
        [currentPrefix, t]
    );

    /**
     * 计算上级前缀
     */
    const getParentPrefix = (prefix: string): string | null => {
        if (!prefix) return null;
        const clean = prefix.endsWith('/') ? prefix.slice(0, -1) : prefix;
        const lastSlash = clean.lastIndexOf('/');
        if (lastSlash === -1) {
            return '';
        }
        return clean.slice(0, lastSlash + 1);
    };

    const parentPrefix = getParentPrefix(currentPrefix);

    useFocusEffect(
        useCallback(() => {
            loadCloudFiles();

            // 仅在当前屏幕获焦时监听 Android 返回键：子目录返回上级，根目录返回上一页
            const backAction = () => {
                if (currentPrefix) {
                    setCurrentPrefix(parentPrefix ?? '');
                    return true;
                }
                return false;
            };

            const backHandler = BackHandler.addEventListener('hardwareBackPress', backAction);
            return () => backHandler.remove();
        }, [loadCloudFiles, currentPrefix, parentPrefix])
    );

    /**
     * 点击单个条目
     */
    const handleItemPress = (item: DisplayItem) => {
        if (item.isDirectory) {
            setCurrentPrefix(item.key);
            return;
        }

        const lastDot = item.name.lastIndexOf('.');
        const ext = lastDot !== -1 ? item.name.slice(lastDot).toLowerCase() : '';
        if (!TEXT_EXTENSIONS.has(ext)) {
            Alert.alert(
                item.name,
                t('browser.unsupportedTextPreview', {
                    defaultValue: '该文件不是支持的纯文本或 Markdown 格式，暂不支持直接在线预览。',
                })
            );
            return;
        }

        if (item.size > MAX_PREVIEW_SIZE) {
            Alert.alert(
                item.name,
                t('browser.fileTooLargePreview', {
                    defaultValue: '该文件体积超过 5MB，暂不支持在手机端直接文本预览。',
                })
            );
            return;
        }

        // 打开在线预览
        navigation.navigate('Preview', {
            filePath: item.key,
            source: 'webdav',
            title: item.name,
        });
    };

    const formatTime = (timeStr?: string) => {
        if (!timeStr) return '-';
        try {
            const d = new Date(timeStr);
            if (isNaN(d.getTime())) return '-';
            const pad = (n: number) => n.toString().padStart(2, '0');
            return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
        } catch {
            return '-';
        }
    };

    const renderItem = ({ item }: { item: DisplayItem }) => {
        const isDir = item.isDirectory;
        const iconName = isDir ? 'folder' : 'description';
        const iconColor = isDir ? theme.colors.primary : theme.colors.textSecondary;

        return (
            <TouchableOpacity
                style={styles.itemContainer}
                onPress={() => handleItemPress(item)}
                activeOpacity={0.65}
            >
                <View style={styles.iconContainer}>
                    <Icon name={iconName} size={28} color={iconColor} />
                </View>
                <View style={styles.contentContainer}>
                    <Text style={styles.itemName} numberOfLines={1}>
                        {item.name}
                    </Text>
                    <Text style={styles.itemDetails}>
                        {isDir ? t('fileItem.folder', { defaultValue: '文件夹' }) : `${(item.size / 1024).toFixed(1)} KB`}{' '}
                        • {formatTime(item.lastModified)}
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
                <Icon name="cloud-off" size={48} color={theme.colors.textSecondary} />
                <Text style={styles.messageTitle}>{t('browser.unconfiguredTitle', { defaultValue: '未配置网盘服务' })}</Text>
                <Text style={styles.messageText}>
                    {t('browser.unconfiguredDesc', { defaultValue: '当前尚未配置 WebDAV 网盘信息，配置后即可在线查看网盘中的历史笔记。' })}
                </Text>
                <TouchableOpacity
                    style={styles.primaryButton}
                    onPress={() => navigation.navigate('CloudRepoConfig')}
                    activeOpacity={0.7}
                >
                    <Text style={styles.primaryButtonText}>{t('browser.goToConfig', { defaultValue: '前往配置网盘' })}</Text>
                </TouchableOpacity>
            </View>
        );
    }

    return (
        <View style={styles.container}>
            {/* 顶部路径条与返回上级 */}
            <View style={styles.pathBar}>
                <TouchableOpacity
                    style={[styles.backParentButton, parentPrefix === null && styles.disabledButton]}
                    onPress={() => parentPrefix !== null && setCurrentPrefix(parentPrefix)}
                    disabled={parentPrefix === null}
                >
                    <Icon name="arrow-upward" size={20} color={parentPrefix !== null ? theme.colors.primary : theme.colors.border} />
                    <Text style={[styles.backParentText, parentPrefix === null && styles.disabledText]}>
                        {t('browser.parentDir', { defaultValue: '上一级' })}
                    </Text>
                </TouchableOpacity>
                <View style={styles.pathTextWrapper}>
                    <Text style={styles.pathText} numberOfLines={1} ellipsizeMode="middle">
                        /{currentPrefix}
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
                    <TouchableOpacity onPress={() => loadCloudFiles(false)}>
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
                    keyExtractor={(item) => item.key}
                    renderItem={renderItem}
                    contentContainerStyle={items.length === 0 ? styles.emptyListContent : styles.listContent}
                    refreshControl={
                        <RefreshControl
                            refreshing={refreshing}
                            onRefresh={() => loadCloudFiles(true)}
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
