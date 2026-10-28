import React, { type ComponentProps } from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import Icon from '@expo/vector-icons/MaterialCommunityIcons';

import { theme } from '../utils/theme';
import { useSettingsFont } from '../components/settings';

const PermissionItem: React.FC<{
    icon: ComponentProps<typeof Icon>['name'];
    title: string;
    description: string;
}> = ({ icon, title, description }) => {
    const font = useSettingsFont();
    return (
    <View style={styles.item}>
        <Icon name={icon} size={22} color={theme.colors.textSecondary} style={styles.icon} />
        <View style={styles.textContainer}>
            <Text style={[styles.title, { fontSize: font.chatBody }]}>{title}</Text>
            <Text style={[styles.description, { fontSize: font.chatBody }]}>{description}</Text>
        </View>
    </View>
    );
};

export const PermissionInfoScreen = () => {
    const { t } = useTranslation();

    return (
        <ScrollView style={styles.container}>
            <View style={styles.group}>
                <PermissionItem
                    icon="wifi"
                    title={t('about.permissions.network.title')}
                    description={t('about.permissions.network.description')}
                />
                <View style={styles.separator} />
                <PermissionItem
                    icon="folder-outline"
                    title={t('about.permissions.storage.title')}
                    description={t('about.permissions.storage.description')}
                />
            </View>
        </ScrollView>
    );
};

const styles = StyleSheet.create({
    container: {
        flex: 1,
        backgroundColor: theme.colors.background,
        paddingTop: theme.spacing.m,
        paddingHorizontal: theme.spacing.s,
    },
    group: {
        backgroundColor: theme.colors.surface,
        borderRadius: theme.radius.sm,
        shadowColor: '#000',
        shadowOffset: { width: 0, height: 1 },
        shadowOpacity: 0.03,
        shadowRadius: 4,
        elevation: 0.5,
        overflow: 'hidden',
    },
    item: {
        flexDirection: 'row',
        alignItems: 'flex-start',
        paddingVertical: theme.spacing.m,
        paddingHorizontal: theme.spacing.m,
    },
    icon: {
        marginRight: theme.spacing.m,
        marginTop: 2,
    },
    textContainer: {
        flex: 1,
    },
    title: {
        fontWeight: '500',
        color: theme.colors.text,
        marginBottom: 4,
    },
    description: {
        color: theme.colors.textSecondary,
        lineHeight: 20,
    },
    separator: {
        height: StyleSheet.hairlineWidth,
        backgroundColor: theme.colors.border,
        marginLeft: theme.spacing.m + 22 + theme.spacing.m,
    },
});
