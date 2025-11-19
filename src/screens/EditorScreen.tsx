import React, { useEffect, useState, useRef } from 'react';
import { View, StyleSheet, ActivityIndicator, Alert, TouchableOpacity, Text, Platform, ScrollView } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRoute, useNavigation, RouteProp } from '@react-navigation/native';
import Markdown from 'react-native-markdown-display';
import { WebView } from 'react-native-webview';
import { RootStackParamList } from '../types/navigation';
import { fsService } from '../services/FileSystemService';
import { theme } from '../utils/theme';

type EditorScreenRouteProp = RouteProp<RootStackParamList, 'Editor'>;

export const EditorScreen = () => {
    const route = useRoute<EditorScreenRouteProp>();
    const navigation = useNavigation();
    const { filePath, isNew } = route.params;
    const [content, setContent] = useState('');
    const [loading, setLoading] = useState(true);
    const [isEditing, setIsEditing] = useState(isNew || false);
    const webViewRef = useRef<WebView>(null);

    useEffect(() => {
        loadFile();
    }, [filePath]);

    const loadFile = async () => {
        try {
            const exists = await fsService.exists(filePath);
            if (exists) {
                const fileContent = await fsService.readFile(filePath);
                setContent(fileContent);
            } else {
                setContent('');
            }
        } catch (error) {
            console.log('Error loading file:', error);
            setContent('');
        } finally {
            setLoading(false);
        }
    };

    const handleSave = async (newContent: string) => {
        try {
            await fsService.writeFile(filePath, newContent);
            setContent(newContent);
            setIsEditing(false);
            // TODO: Add to Upload Queue
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
                <Text style={styles.title} numberOfLines={1}>
                    {filePath.split('/').pop()}
                </Text>
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

            {isEditing ? (
                <WebView
                    ref={webViewRef}
                    source={
                        Platform.OS === 'android'
                            ? { uri: 'file:///android_asset/editor.html' }
                            : require('../../android/app/src/main/assets/editor.html') // Fallback/iOS logic needs adjustment
                    }
                    onMessage={onWebViewMessage}
                    onLoadEnd={() => {
                        // Send initial content via postMessage
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
        // height: 60, // Removed fixed height to accommodate content naturally
    },
    headerButton: {
        padding: theme.spacing.s,
    },
    headerButtonText: {
        color: theme.colors.primary,
        fontSize: 16,
        fontWeight: 'bold',
    },
    title: {
        flex: 1,
        textAlign: 'center',
        fontSize: 18,
        fontWeight: 'bold',
        marginHorizontal: theme.spacing.s,
    },
    webview: {
        flex: 1,
    },
    viewerContainer: {
        flex: 1,
        padding: theme.spacing.m,
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
