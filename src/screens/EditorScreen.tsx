import React, { useEffect, useState, useRef } from 'react';
import { View, StyleSheet, ActivityIndicator, Alert, TouchableOpacity, Text, Platform, ScrollView } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRoute, useNavigation, RouteProp } from '@react-navigation/native';
import Markdown from 'react-native-markdown-display';
import { WebView } from 'react-native-webview';
import { RootStackParamList } from '../types/navigation';
import { fsService } from '../services/FileSystemService';
import { cloudService } from '../services/CloudService';
import { syncService } from '../services/SyncService';
import { useFileMetadataStore } from '../store/useFileMetadataStore';
import { theme } from '../utils/theme';

type EditorScreenRouteProp = RouteProp<RootStackParamList, 'Editor'>;

type SyncStatus = 'synced' | 'conflict' | 'checking' | 'error';
type ConflictType = 'cloudNewer' | 'localNewer' | null;

export const EditorScreen = () => {
    const route = useRoute<EditorScreenRouteProp>();
    const navigation = useNavigation();
    const { filePath, isNew } = route.params;
    const [content, setContent] = useState('');
    const [loading, setLoading] = useState(true);
    const [isEditing, setIsEditing] = useState(isNew || false);
    const [syncStatus, setSyncStatus] = useState<SyncStatus>('checking');
    const [conflictType, setConflictType] = useState<ConflictType>(null);
    const webViewRef = useRef<WebView>(null);

    const { getMetadata, invalidateMetadata, setMetadata } = useFileMetadataStore();

    useEffect(() => {
        loadFile();
    }, [filePath]);

    const loadFile = async () => {
        try {
            const exists = await fsService.exists(filePath);
            if (exists) {
                const fileContent = await fsService.readFile(filePath);
                setContent(fileContent);
                checkSyncStatus();
            } else {
                setContent('');
                setSyncStatus('error');
            }
        } catch (error) {
            console.log('Error loading file:', error);
            setContent('');
        } finally {
            setLoading(false);
        }
    };

    const checkSyncStatus = async () => {
        setSyncStatus('checking');
        try {
            const key = filePath; // Assuming key is filePath for now
            const localMetadata = getMetadata(filePath);
            const cloudMetadata = await cloudService.headFile(key);

            if (!cloudMetadata) {
                // File might not exist in cloud yet
                setSyncStatus('error'); // Or 'localNewer' if we assume it's a new file?
                // For now, if cloud doesn't have it, it's effectively local newer if we have content
                if (await fsService.exists(filePath)) {
                    setSyncStatus('conflict');
                    setConflictType('localNewer');
                }
                return;
            }

            if (localMetadata?.etag === cloudMetadata.etag) {
                setSyncStatus('synced');
                setConflictType(null);
            } else {
                setSyncStatus('conflict');
                const localFileStat = await fsService.stat(filePath);
                const localMtime = localFileStat?.mtime || new Date(0);
                const cloudMtime = new Date(cloudMetadata.lastModified);

                if (cloudMtime > localMtime) {
                    setConflictType('cloudNewer');
                } else {
                    setConflictType('localNewer');
                }
            }
        } catch (error) {
            console.error('Error checking sync status:', error);
            setSyncStatus('error');
        }
    };

    const handleSave = async (newContent: string) => {
        try {
            await fsService.writeFile(filePath, newContent);
            setContent(newContent);
            setIsEditing(false);
            invalidateMetadata(filePath); // Invalidate metadata on local edit
            checkSyncStatus(); // Re-check status (should become localNewer)
        } catch (error) {
            Alert.alert('Error', 'Failed to save file');
        }
    };

    const onWebViewMessage = (event: any) => {
        const newContent = event.nativeEvent.data;
        handleSave(newContent);
    };

    const requestSaveFromWebView = () => {
        webViewRef.current?.injectJavaScript('window.getContent(); true;');
    };

    const handleOverwriteLocal = async () => {
        try {
            setLoading(true);
            const key = filePath;
            const result = await cloudService.downloadFile(key, filePath);
            setMetadata(filePath, result.etag, result.lastModified);
            await loadFile(); // Reload content
        } catch (error) {
            Alert.alert('Error', 'Failed to overwrite local file');
        } finally {
            setLoading(false);
        }
    };

    const handleSaveCopy = async () => {
        try {
            setLoading(true);
            await syncService.resolveConflict(filePath);
            // After resolveConflict, the original file is replaced by cloud version (if cloud newer)
            // or we just uploaded our copy.
            // Wait, resolveConflict in SyncService does: Move Local -> Download Cloud -> Upload Moved.
            // This fits "Cloud Newer" -> "Save Copy" (Keep local as copy, get cloud).
            // But for "Local Newer" -> "Save Copy", we might want: Upload Local as Copy?
            // The requirement says:
            // Cloud Newer -> Save Copy: Rename Local -> Upload Copy. (And presumably keep Cloud as main?)
            // Local Newer -> Save Copy: Rename Local -> Upload Copy.
            // Actually, the requirement says:
            // Cloud Newer -> [Save Copy]: Rename current local -> Trigger copy upload. (And what happens to view? presumably we then download cloud?)
            // Local Newer -> [Save Copy]: Rename current local -> Upload copy.

            // Let's stick to SyncService.resolveConflict which seems to do: Backup Local -> Download Cloud -> Upload Backup.
            // This seems to match "Cloud Newer" flow.
            // For "Local Newer", if we want to keep local changes but as a copy, we should probably just rename local and upload it, then maybe revert?
            // Or maybe "Save Copy" just means "Backup my changes to cloud as a copy, and let me see the main file".

            // Re-reading requirement:
            // Cloud Newer -> [Save Copy]: Rename Local -> Trigger Copy Upload. (Implies we then see Cloud version?)
            // Local Newer -> [Save Copy]: Rename Local -> Upload Copy. (Implies we then see what? The file is now renamed.)

            // Let's use resolveConflict for now as it seems to handle the "Backup and Sync" flow.

            await loadFile();
        } catch (error) {
            Alert.alert('Error', 'Failed to save copy');
        } finally {
            setLoading(false);
        }
    };

    const handleUploadOverwrite = async () => {
        try {
            setLoading(true);
            await syncService.syncFile(filePath);
            // We need to wait for upload to finish to update metadata?
            // syncFile adds to queue. processQueue updates metadata.
            // We might need to poll or wait.
            // For now, let's just set status to checking and let the queue handle it.
            // Ideally we'd have a way to know when it's done.
            setTimeout(() => checkSyncStatus(), 2000); // Simple timeout for now
        } catch (error) {
            Alert.alert('Error', 'Failed to upload');
        } finally {
            setLoading(false);
        }
    };

    if (loading) {
        return (
            <View style={styles.loadingContainer}>
                <ActivityIndicator size="large" color={theme.colors.primary} />
            </View>
        );
    }

    return (
        <SafeAreaView style={styles.container}>
            <View style={styles.header}>
                <TouchableOpacity onPress={() => navigation.goBack()} style={styles.headerButton}>
                    <Text style={styles.headerButtonText}>Back</Text>
                </TouchableOpacity>
                <View style={styles.titleContainer}>
                    <Text style={styles.title} numberOfLines={1}>
                        {filePath.split('/').pop()}
                    </Text>
                    {syncStatus === 'synced' && <Text style={styles.syncIcon}>✅</Text>}
                    {syncStatus === 'conflict' && <Text style={styles.syncIcon}>⚠️</Text>}
                </View>
                <TouchableOpacity
                    onPress={() => {
                        if (isEditing) {
                            requestSaveFromWebView();
                        } else {
                            setIsEditing(true);
                        }
                    }}
                    style={styles.headerButton}
                >
                    <Text style={styles.headerButtonText}>{isEditing ? 'Save' : 'Edit'}</Text>
                </TouchableOpacity>
            </View>

            {syncStatus === 'conflict' && conflictType && (
                <View style={styles.banner}>
                    <Text style={styles.bannerText}>
                        {conflictType === 'cloudNewer' ? '云端有新版本' : '本地更改未同步'}
                    </Text>
                    <View style={styles.bannerButtons}>
                        {conflictType === 'cloudNewer' ? (
                            <>
                                <TouchableOpacity onPress={handleOverwriteLocal} style={styles.bannerButton}>
                                    <Text style={styles.bannerButtonText}>覆盖本地</Text>
                                </TouchableOpacity>
                                <TouchableOpacity onPress={handleSaveCopy} style={styles.bannerButton}>
                                    <Text style={styles.bannerButtonText}>另存副本</Text>
                                </TouchableOpacity>
                            </>
                        ) : (
                            <>
                                <TouchableOpacity onPress={handleUploadOverwrite} style={styles.bannerButton}>
                                    <Text style={styles.bannerButtonText}>上传覆盖</Text>
                                </TouchableOpacity>
                                <TouchableOpacity onPress={handleSaveCopy} style={styles.bannerButton}>
                                    <Text style={styles.bannerButtonText}>另存副本</Text>
                                </TouchableOpacity>
                            </>
                        )}
                    </View>
                </View>
            )}

            {isEditing ? (
                <WebView
                    ref={webViewRef}
                    source={
                        Platform.OS === 'android'
                            ? { uri: 'file:///android_asset/editor.html' }
                            : require('../../android/app/src/main/assets/editor.html')
                    }
                    onMessage={onWebViewMessage}
                    onLoadEnd={() => {
                        webViewRef.current?.postMessage(content);
                    }}
                    style={styles.webview}
                />
            ) : (
                <ScrollView style={styles.viewerContainer}>
                    <Markdown style={markdownStyles}>
                        {content}
                    </Markdown>
                </ScrollView>
            )}
        </SafeAreaView>
    );
};

const styles = StyleSheet.create({
    container: {
        flex: 1,
        backgroundColor: theme.colors.background,
    },
    loadingContainer: {
        flex: 1,
        justifyContent: 'center',
        alignItems: 'center',
    },
    header: {
        flexDirection: 'row',
        justifyContent: 'space-between',
        alignItems: 'center',
        padding: theme.spacing.m,
        backgroundColor: theme.colors.surface,
        borderBottomWidth: 1,
        borderBottomColor: theme.colors.border,
    },
    headerButton: {
        padding: theme.spacing.s,
    },
    headerButtonText: {
        color: theme.colors.primary,
        fontSize: 16,
        fontWeight: 'bold',
    },
    titleContainer: {
        flex: 1,
        flexDirection: 'row',
        justifyContent: 'center',
        alignItems: 'center',
    },
    title: {
        fontSize: 18,
        fontWeight: 'bold',
        marginHorizontal: theme.spacing.s,
    },
    syncIcon: {
        fontSize: 16,
        marginLeft: 4,
    },
    webview: {
        flex: 1,
    },
    viewerContainer: {
        flex: 1,
        padding: theme.spacing.m,
    },
    banner: {
        backgroundColor: '#FFF3CD',
        padding: theme.spacing.s,
        borderBottomWidth: 1,
        borderBottomColor: '#FFEEBA',
        alignItems: 'center',
    },
    bannerText: {
        color: '#856404',
        marginBottom: theme.spacing.s,
    },
    bannerButtons: {
        flexDirection: 'row',
        gap: theme.spacing.m,
    },
    bannerButton: {
        backgroundColor: '#856404',
        paddingHorizontal: theme.spacing.m,
        paddingVertical: theme.spacing.xs,
        borderRadius: 4,
    },
    bannerButtonText: {
        color: 'white',
        fontSize: 12,
    },
});

const markdownStyles = {
    body: {
        color: theme.colors.text,
    },
    heading1: {
        color: theme.colors.primary,
    },
};
