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

    const handleGoBack = () => {
        if (!prefix) return;
        const parts = prefix.split('/').filter(Boolean);
        parts.pop();
        const parentPrefix = parts.length > 0 ? parts.join('/') + '/' : '';
        setPrefix(parentPrefix);
    };

    useEffect(() => {
        navigation.setOptions({
            title: prefix ? prefix.split('/').slice(-2, -1)[0] : t('tabs.browser'),
            headerLeft: () =>
                prefix ? (
                    <TouchableOpacity onPress={handleGoBack} style={styles.headerBackButton}>
                        <Text style={styles.headerBackButtonText}>{t('browser.goBack')}</Text>
                    </TouchableOpacity>
                ) : undefined,
        });
    }, [navigation, prefix, t]);

    useFocusEffect(useCallback(() => { loadFiles(); }, [loadFiles]));

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
                        await cloudService.downloadFile(item.path, item.path);
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
                        renderItem={({ item }) => <FileListItem item={item} onPress={handleFilePress} />}
                        keyExtractor={(item) => item.path}
                        refreshControl={<RefreshControl refreshing={false} onRefresh={loadFiles} />}
                        ListEmptyComponent={<MessageView title={t('browser.emptyTitle')} message={t('browser.emptyMessage')} />}
                    />
                );
        }
    };

    return <View style={styles.container}>{renderContent()}</View>;
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
