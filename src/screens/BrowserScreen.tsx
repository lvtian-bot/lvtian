import React, { useState, useCallback, useEffect } from 'react';
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
import { useFocusEffect, useNavigation } from '@react-navigation/native';
import { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { useTranslation } from 'react-i18next';

import { FileListItem } from '../components/FileListItem';
import { theme } from '../utils/theme';
import { RootStackParamList } from '../types/navigation';
import { FileItem, fsService } from '../services/FileSystemService';
import { cloudService } from '../services/CloudService';
import { useSettingsStore } from '../store/useSettingsStore';
import { useFileMetadataStore } from '../store/useFileMetadataStore';

import { Breadcrumb } from '../components/Breadcrumb';

type NavigationProp = NativeStackNavigationProp<RootStackParamList>;
type Status = 'idle' | 'loading' | 'success' | 'error' | 'unconfigured';

const MessageView = ({ title, message, buttonText, onButtonPress }: { title: string; message: string; buttonText?: string; onButtonPress?: () => void; }) => (
    <View style={styles.messageContainer}>
        <Text style={styles.messageTitle}>{title}</Text>
        <Text style={styles.messageText}>{message}</Text>
        {buttonText && onButtonPress && (
            <TouchableOpacity style={styles.button} onPress={onButtonPress}>
                <Text style={styles.buttonText}>{buttonText}</Text>
            </TouchableOpacity>
        )}
    </View>
);

export const BrowserScreen = () => {
    const { t } = useTranslation();
    const [files, setFiles] = useState<FileItem[]>([]);
    const [status, setStatus] = useState<Status>('idle');
    const [errorMessage, setErrorMessage] = useState('');
    const [prefix, setPrefix] = useState('');

    const navigation = useNavigation<NavigationProp>();
    const { cosConfig } = useSettingsStore();

    const loadFiles = useCallback(async () => {
        if (!cloudService.isConfigured()) {
            setStatus('unconfigured');
            return;
        }
        setStatus('loading');
        try {
            const cloudFiles = await cloudService.listFiles(prefix);
            const fileList: FileItem[] = cloudFiles.map((item): FileItem => ({
                name: item.key.endsWith('/')
                    ? item.key.split('/').slice(-2, -1)[0] + '/'
                    : item.key.split('/').pop() ?? item.key,
                path: item.key,
                size: item.size,
                isDirectory: item.key.endsWith('/'),
                mtime: new Date(item.lastModified),
            }));

            fileList.sort((a, b) => {
                if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1;
                return a.name.localeCompare(b.name);
            });

            setFiles(fileList);
            setStatus('success');
        } catch (error: any) {
            console.error('Failed to load cloud files:', error);
            let message = t('browser.error.default');
            if (error && error.code) {
                switch (error.code) {
                    case 'SignatureDoesNotMatch': message = t('browser.error.auth'); break;
                    case 'NoSuchBucket': message = t('browser.error.bucket'); break;
                    case 'NetworkError': message = t('browser.error.network'); break;
                }
            }
            setErrorMessage(message);
            setStatus('error');
        }
    }, [cosConfig, prefix, t]);

    const handlePathPress = (newPath: string) => {
        setPrefix(newPath);
    };

    // Set a static title once
    useEffect(() => {
        navigation.setOptions({
            title: t('tabs.browser'),
        });
    }, [navigation, t]);

    // This effect will handle the hardware back button
    useFocusEffect(
        useCallback(() => {
            const onBackPress = () => {
                if (prefix) {
                    const parts = prefix.split('/').filter(Boolean);
                    parts.pop();
                    const parentPrefix = parts.length > 0 ? parts.join('/') + '/' : '';
                    setPrefix(parentPrefix);
                    return true; // Prevent default action
                }
                return false; // Allow default action
            };

            const subscription = BackHandler.addEventListener('hardwareBackPress', onBackPress);

            return () => subscription.remove();
        }, [prefix])
    );

    useFocusEffect(useCallback(() => { loadFiles(); }, [loadFiles]));

    const handleDeleteFile = async (fileToDelete: FileItem) => {
        console.log('=== handleDeleteFile called ===');
        console.log('File to delete:', fileToDelete.name);

        try {
            Alert.alert(
                t('common.confirm'),
                t('browser.confirmDelete', { fileName: fileToDelete.name }),
                [
                    { text: t('common.cancel'), style: 'cancel' },
                    {
                        text: t('common.confirm'),
                        onPress: async () => {
                        try {
                            console.log('=== Starting delete operation ===');
                            console.log('File to delete:', fileToDelete.name);
                            console.log('File path:', fileToDelete.path);

                            // Step 1: Delete from local file system first (safer - can recover from cloud)
                            const localFileExists = await fsService.exists(fileToDelete.path);
                            console.log('Local file exists:', localFileExists);

                            if (localFileExists) {
                                await fsService.deleteFile(fileToDelete.path);
                                console.log('Local file deleted');
                            }

                            // Step 2: Delete from the cloud
                            console.log('Starting cloud delete...');
                            await cloudService.deleteFile(fileToDelete.path);
                            console.log('Cloud delete successful!');

                            // Temporarily remove Alert to avoid Android Activity issue
                            console.log('Delete completed successfully');
                            loadFiles(); // Refresh the list
                        } catch (error) {
                            console.error('Failed to delete file:', error);
                            console.error('Error type:', typeof error);
                            console.error('Error message:', error instanceof Error ? error.message : String(error));

                            // Show error alert with delay to ensure Activity is ready
                            setTimeout(() => {
                                Alert.alert(t('common.error'), t('browser.deleteFailed') + '\n' + (error instanceof Error ? error.message : String(error)));
                            }, 500);
                        }
                    },
                },
            ],
                { cancelable: true }
            );
        } catch (error) {
            console.error('Error showing delete confirmation:', error);
        }
    };

    const handleFilePress = async (item: FileItem) => {
        if (item.isDirectory) {
            setPrefix(item.path);
        } else {
            if (item.name.endsWith('.md')) {
                try {
                    const exists = await fsService.exists(item.path);
                    if (exists) {
                        navigation.navigate('Editor', { filePath: item.path });
                    } else {
                        setStatus('loading');
                        const result = await cloudService.downloadFile(item.path, item.path);
                        
                        // Set the metadata for the newly downloaded file
                        const { setMetadata } = useFileMetadataStore.getState();
                        setMetadata(item.path, result.etag, result.lastModified);
                        
                        setStatus('success');
                        navigation.navigate('Editor', { filePath: item.path });
                    }
                } catch (error) {
                    console.error('Failed to open file:', error);
                    setStatus('success'); // Restore UI
                    Alert.alert(t('browser.error.downloadFailed'), String(error));
                }
            } else {
                console.log('Not a markdown file:', item.name);
                Alert.alert(t('browser.info.notMarkdown'));
            }
        }
    };

    const renderContent = () => {
        switch (status) {
            case 'loading':
            case 'idle':
                return <ActivityIndicator style={styles.messageContainer} size="large" />;
            case 'error':
                return <MessageView title={t('browser.loadingFailedTitle')} message={errorMessage} buttonText={t('browser.retry')} onButtonPress={loadFiles} />;
            case 'unconfigured':
                return <MessageView title={t('browser.unconfiguredTitle')} message={t('browser.unconfiguredMessage')} buttonText={t('browser.goToSettings')} onButtonPress={() => navigation.navigate('MainTabs', { screen: 'Settings' })} />;
            case 'success':
                return (
                    <FlatList
                        data={files}
                        renderItem={({ item }) => (
                            <FileListItem
                                item={item}
                                onPress={handleFilePress}
                                onDelete={handleDeleteFile} // Pass the delete handler
                            />
                        )}
                        keyExtractor={(item) => item.path}
                        refreshControl={<RefreshControl refreshing={false} onRefresh={loadFiles} />}
                        ListEmptyComponent={<MessageView title={t('browser.emptyTitle')} message={t('browser.emptyMessage')} />}
                    />
                );
        }
    };

    return (
        <View style={styles.container}>
            <Breadcrumb path={prefix} onPathPress={handlePathPress} />
            {renderContent()}
        </View>
    );
};

const styles = StyleSheet.create({
    container: { flex: 1, backgroundColor: theme.colors.background },
    messageContainer: { flex: 1, justifyContent: 'center', alignItems: 'center', padding: theme.spacing.l },
    messageTitle: { fontSize: theme.typography.h2.fontSize, fontWeight: 'bold', color: theme.colors.text, marginBottom: theme.spacing.m, textAlign: 'center' },
    messageText: { color: theme.colors.textSecondary, fontSize: theme.typography.body.fontSize, textAlign: 'center', lineHeight: 22 },
    button: { backgroundColor: theme.colors.primary, paddingVertical: theme.spacing.s, paddingHorizontal: theme.spacing.l, borderRadius: 8, alignItems: 'center', marginTop: theme.spacing.l },
    buttonText: { color: theme.colors.white, fontSize: 16, fontWeight: 'bold' },
    headerBackButton: { marginLeft: -5, padding: 10 },
    headerBackButtonText: { color: theme.colors.primary, fontSize: 16 },
});
