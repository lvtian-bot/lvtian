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
import { auxFontSizes } from '../utils/fontSize';
import { useSettingsFont } from '../components/settings';
import { RootStackParamList } from '../types/navigation';
import { cloudService, CLOUD_INIT_COMPLETED_EVENT } from '../services/CloudService';

type NavigationProp = NativeStackNavigationProp<RootStackParamList>;
type RoutePropType = RouteProp<RootStackParamList, 'CloudFileList'>;

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
    const font = useSettingsFont();
    const navigation = useNavigation<NavigationProp>();
    const route = useRoute<RoutePropType>();

    const [currentPrefix, setCurrentPrefix] = useState<string>(route.params?.prefix || '');
    const [items, setItems] = useState<DisplayItem[]>([]);
    // 已成功加载条目对应的目录前缀：用于区分「切换目录」与「同目录刷新」，决定是否清空旧条目。
    // 存放在 ref 中，避免进入加载回调的依赖导致聚焦期间回调重建、重复发起列表请求
    const loadedPrefixRef = useRef<string | null>(null);
    const [loading, setLoading] = useState<boolean>(false);
    const [refreshing, setRefreshing] = useState<boolean>(false);
    const [errorMessage, setErrorMessage] = useState<string | null>(null);
    const [isConfigured, setIsConfigured] = useState<boolean>(cloudService.isConfigured());
    const requestIdRef = useRef<number>(0);
    // 云盘提供方初始化/重配置的代数：变化时在渲染提交后触发一次根目录加载
    const [providerEpoch, setProviderEpoch] = useState(0);

    const resetForProvider = () => {
        setIsConfigured(cloudService.isConfigured());
        // 当网盘重新配置或初始化时，重置当前子路径到根目录，清空旧条目，避免跨账号/新配置请求旧子目录；
        // 同时作废仍在途的旧账号请求，防止其返回后重新填充旧条目
        requestIdRef.current++;
        setCurrentPrefix('');
        setItems([]);
        loadedPrefixRef.current = '';
    };

    // 监听云存储初始化完成事件，确保非响应式的 SecureStore 异步读取完成后及时更新界面
    useEffect(() => {
        const sub = DeviceEventEmitter.addListener(CLOUD_INIT_COMPLETED_EVENT, () => {
            resetForProvider();
            // 初始化完成（如启动期密码异步读取到位）后自动加载根目录，
            // 修复首查报「未配置」后前缀未变、聚焦效应不再触发导致的空白列表
            setProviderEpoch(e => e + 1);
        });
        resetForProvider();
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

            // 切换到新目录时立即清空上一目录条目，防止新目录加载失败后仍显示父目录内容
            if (loadedPrefixRef.current !== null && loadedPrefixRef.current !== currentPrefix) {
                setItems([]);
            }

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
                loadedPrefixRef.current = currentPrefix;
            } catch (err: unknown) {
                if (reqId === requestIdRef.current) {
                    const serverErr = err as { code?: string; message?: string };
                    const code = serverErr.code;
                    let message = (err as Error).message || t('browser.error.network', { defaultValue: '连接网盘失败，请检查网络' });
                    if (code) {
                        message = t(`browser.error.${code}`, { defaultValue: message });
                    }
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

    // 经 ref 调用最新版加载函数：直接把 loadCloudFiles 放进下 方 effect 的依赖会随前缀变化重复加载
    const loadCloudFilesRef = useRef(loadCloudFiles);
    useEffect(() => {
        loadCloudFilesRef.current = loadCloudFiles;
    }, [loadCloudFiles]);

    // 提供方初始化/重配置完成后（渲染已提交、加载函数已捕获重置后的空前缀）自动加载根目录
    useEffect(() => {
        if (providerEpoch > 0 && cloudService.isConfigured()) {
            loadCloudFilesRef.current();
        }
    }, [providerEpoch]);

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
                    <Text style={[styles.itemName, { fontSize: font.chatBody }]} numberOfLines={1}>
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
                <Text style={[styles.messageTitle, { fontSize: font.chatHeading2 }]}>{t('browser.unconfiguredTitle', { defaultValue: '未配置网盘服务' })}</Text>
                <Text style={[styles.messageText, { fontSize: font.chatBody }]}>
                    {t('browser.unconfiguredDesc', { defaultValue: '当前尚未配置 WebDAV 网盘信息，配置后即可在线查看网盘中的历史笔记。' })}
                </Text>
                <TouchableOpacity
                    style={styles.primaryButton}
                    onPress={() => navigation.navigate('CloudRepoConfig')}
                    activeOpacity={0.7}
                >
                    <Text style={[styles.primaryButtonText, { fontSize: font.chatBody }]}>{t('browser.goToConfig', { defaultValue: '前往配置网盘' })}</Text>
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
                    <Icon name="error-outline" size={18} color={theme.colors.dangerStrong} />
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
                    <Text style={[styles.loadingText, { fontSize: font.chatBody }]}>{t('common.loading', { defaultValue: '加载中...' })}</Text>
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
                                <Text style={[styles.emptyText, { fontSize: font.chatBody }]}>{t('browser.emptyDirectory', { defaultValue: '此目录下暂无文件' })}</Text>
                            </View>
                        ) : undefined
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
        borderBottomColor: theme.colors.skeleton,
        gap: 8,
    },
    backParentButton: {
        flexDirection: 'row',
        alignItems: 'center',
        paddingHorizontal: 8,
        paddingVertical: 4,
        borderRadius: 6,
        backgroundColor: theme.colors.skeleton,
        gap: 2,
    },
    disabledButton: {
        backgroundColor: theme.colors.skeleton,
    },
    backParentText: {
        fontSize: auxFontSizes.caption,
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
        fontSize: auxFontSizes.caption,
        color: theme.colors.textSecondary,
        fontFamily: 'monospace',
    },
    errorBanner: {
        flexDirection: 'row',
        alignItems: 'center',
        backgroundColor: theme.colors.dangerBg,
        paddingHorizontal: 16,
        paddingVertical: 8,
        gap: 8,
    },
    errorBannerText: {
        flex: 1,
        fontSize: auxFontSizes.caption,
        color: theme.colors.dangerStrong,
    },
    retryText: {
        fontSize: auxFontSizes.caption,
        fontWeight: 'bold',
        color: theme.colors.dangerStrong,
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
        borderBottomColor: theme.colors.skeleton,
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
        fontWeight: '500',
        color: theme.colors.text,
        marginBottom: 2,
    },
    itemDetails: {
        fontSize: auxFontSizes.caption,
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
        color: theme.colors.textSecondary,
    },
    loadingText: {
        marginTop: 12,
        color: theme.colors.textSecondary,
    },
    messageTitle: {
        fontWeight: 'bold',
        color: theme.colors.text,
        marginTop: 16,
        marginBottom: 8,
    },
    messageText: {
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
        color: theme.colors.white,
        fontWeight: '600',
    },
});
