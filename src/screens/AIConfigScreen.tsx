import React, { useState } from 'react';
import { View, Text, TextInput, StyleSheet, TouchableOpacity, ScrollView, Alert } from 'react-native';
import { useNavigation } from '@react-navigation/native';
import { useTranslation } from 'react-i18next';
import { useAIStore } from '../store/useAIStore';
import { theme } from '../utils/theme';
import Icon from '@expo/vector-icons/MaterialIcons';

export const AIConfigScreen = () => {
    const navigation = useNavigation();
    const { t } = useTranslation();
    const { config, setConfig } = useAIStore();

    const [baseUrl, setBaseUrl] = useState(config.baseUrl);
    const [apiKey, setApiKey] = useState(config.apiKey);
    const [model, setModel] = useState(config.model);

    const handleSave = () => {
        if (!baseUrl || !apiKey || !model) {
            Alert.alert(t('common.error'), t('settings.error.notEmpty') || 'Please fill in all fields');
            return;
        }

        setConfig({ baseUrl, apiKey, model });
        Alert.alert(t('common.success'), t('settings.success') || 'Configuration saved');
        navigation.goBack();
    };

    return (
        <ScrollView style={styles.container}>
            <View style={styles.form}>
                <Text style={styles.description}>{t('ai.settingsSubtitle')}</Text>
                
                <View style={styles.inputGroup}>
                    <Text style={styles.label}>{t('ai.baseUrl')}</Text>
                    <TextInput
                        style={styles.input}
                        value={baseUrl}
                        onChangeText={setBaseUrl}
                        placeholder="https://api.openai.com/v1"
                        placeholderTextColor={theme.colors.textSecondary}
                        autoCapitalize="none"
                    />
                    <Text style={styles.helperText}>{t('ai.baseUrlDesc')}</Text>
                </View>

                <View style={styles.inputGroup}>
                    <Text style={styles.label}>{t('ai.apiKey')}</Text>
                    <TextInput
                        style={styles.input}
                        value={apiKey}
                        onChangeText={setApiKey}
                        placeholder="sk-..."
                        placeholderTextColor={theme.colors.textSecondary}
                        secureTextEntry
                        autoCapitalize="none"
                    />
                </View>

                <View style={styles.inputGroup}>
                    <Text style={styles.label}>{t('ai.model')}</Text>
                    <TextInput
                        style={styles.input}
                        value={model}
                        onChangeText={setModel}
                        placeholder="gpt-3.5-turbo"
                        placeholderTextColor={theme.colors.textSecondary}
                        autoCapitalize="none"
                    />
                    <Text style={styles.helperText}>{t('ai.modelDesc')}</Text>
                </View>

                <TouchableOpacity style={styles.saveButton} onPress={handleSave}>
                    <Icon name="save" size={24} color="white" style={styles.saveIcon} />
                    <Text style={styles.saveButtonText}>{t('common.save') || 'Save'}</Text>
                </TouchableOpacity>
            </View>
        </ScrollView>
    );
};

const styles = StyleSheet.create({
    container: {
        flex: 1,
        backgroundColor: theme.colors.background,
    },
    form: {
        padding: theme.spacing.l,
    },
    description: {
        fontSize: 14,
        color: theme.colors.textSecondary,
        marginBottom: theme.spacing.l,
        lineHeight: 20,
    },
    inputGroup: {
        marginBottom: theme.spacing.l,
    },
    label: {
        fontSize: 16,
        fontWeight: '600',
        color: theme.colors.text,
        marginBottom: 8,
    },
    input: {
        backgroundColor: theme.colors.surface,
        borderWidth: 1,
        borderColor: theme.colors.border,
        borderRadius: 8,
        padding: 12,
        fontSize: 16,
        color: theme.colors.text,
    },
    helperText: {
        marginTop: 4,
        fontSize: 12,
        color: theme.colors.textSecondary,
    },
    saveButton: {
        backgroundColor: theme.colors.primary,
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 16,
        borderRadius: 12,
        marginTop: theme.spacing.m,
    },
    saveIcon: {
        marginRight: 8,
    },
    saveButtonText: {
        color: 'white',
        fontSize: 18,
        fontWeight: 'bold',
    },
});
