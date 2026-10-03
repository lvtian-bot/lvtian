import React, { useMemo, type ComponentProps } from 'react';
import {
    ScrollView,
    StyleSheet,
    Text,
    View,
    Linking,
    Alert,
    TouchableOpacity,
} from 'react-native';
import { useTranslation } from 'react-i18next';
import { useNavigation } from '@react-navigation/native';
import { NativeStackNavigationProp } from '@react-navigation/native-stack';
import * as Clipboard from 'expo-clipboard';
import Constants from 'expo-constants';
import Icon from '@expo/vector-icons/MaterialCommunityIcons';

import { theme } from '../utils/theme';
import { RootStackParamList } from '../types/navigation';
import {
    HELP_DOC_URL,
    PRIVACY_POLICY_URL,
    CONTACT_EMAIL,
    OFFICIAL_ACCOUNT_NAME,
} from '../config';

const openLink = async (url: string, loadError: string) => {
    // HTTPS 链接直接 openURL：Android 11+ 上 canOpenURL 需要额外声明 queries，
    // 直接调用并捕获失败更可靠
    try {
        await Linking.openURL(url);
    } catch {
        Alert.alert(loadError, url);
    }
};

type AboutScreenNavigationProp = NativeStackNavigationProp<RootStackParamList>;

export const AboutScreen = () => {
    const { t } = useTranslation();
    const navigation = useNavigation<AboutScreenNavigationProp>();

    const appVersion = useMemo(() => {
        return Constants.expoConfig?.version || '1.0.0';
    }, []);

    const handleCopyOfficialAccount = async () => {
        await Clipboard.setStringAsync(OFFICIAL_ACCOUNT_NAME);
        Alert.alert(
            t('about.officialAccount.copied_title'),
            t('about.officialAccount.copied_message'),
            [
                { text: t('common.cancel'), style: 'cancel' },
                {
                    text: t('common.confirm'),
                    onPress: async () => {
                        try {
                            await Linking.openURL('weixin://');
                        } catch (e) {
                            // ignore: 未安装微信时不做处理
                        }
                    },
                },
            ]
        );
    };

    const handleCopyEmail = async () => {
        await Clipboard.setStringAsync(CONTACT_EMAIL);
        Alert.alert(
            t('about.contact.email_copied_title'),
            t('about.contact.email_copied_message'),
            [
                { text: t('common.cancel'), style: 'cancel' },
                {
                    text: t('about.contact.cta'),
                    onPress: async () => {
                        try {
                            await Linking.openURL(`mailto:${CONTACT_EMAIL}`);
                        } catch (err) {
                            Alert.alert(
                                t('about.contact.email_error.title'),
                                t('about.contact.email_error.message')
                            );
                        }
                    },
                },
            ]
        );
    };

    const renderRow = (
        icon: ComponentProps<typeof Icon>['name'],
        label: string,
        onPress?: () => void,
        right?: React.ReactNode
    ) => (
        <TouchableOpacity
            style={styles.row}
            onPress={onPress}
            activeOpacity={onPress ? 0.7 : 1}
            disabled={!onPress}
        >
            <View style={styles.rowLeft}>
                <Icon name={icon} size={22} color={theme.colors.textSecondary} style={styles.rowIcon} />
                <Text style={styles.rowLabel}>{label}</Text>
            </View>
            {right ?? (onPress ? (
                <Icon name="chevron-right" size={20} color={theme.colors.textSecondary} />
            ) : null)}
        </TouchableOpacity>
    );

    const separator = <View style={styles.separator} />;

    return (
        <ScrollView style={styles.container}>
            {/* 使用帮助、隐私政策、权限说明 */}
            <View style={styles.group}>
                {renderRow('help-circle-outline', t('about.help.title'), () =>
                    openLink(HELP_DOC_URL, t('about.linkError'))
                )}
                {separator}
                {renderRow('shield-lock-outline', t('about.privacy.title'), () =>
                    openLink(PRIVACY_POLICY_URL, t('about.linkError'))
                )}
                {separator}
                {renderRow('security', t('about.permissions.title'), () =>
                    navigation.navigate('PermissionInfo')
                )}
            </View>

            {/* 开发者信息 */}
            <View style={styles.group}>
                {renderRow(
                    'wechat',
                    t('about.developer.officialAccount'),
                    handleCopyOfficialAccount,
                    <View style={styles.valueWithIcon}>
                        <Text style={styles.rowValue}>{OFFICIAL_ACCOUNT_NAME}</Text>
                        <Icon name="content-copy" size={18} color={theme.colors.textSecondary} />
                    </View>
                )}
                {separator}
                {renderRow(
                    'email-outline',
                    t('about.contact.title'),
                    handleCopyEmail,
                    <View style={styles.valueWithIcon}>
                        <Text style={styles.rowValue} numberOfLines={1}>{CONTACT_EMAIL}</Text>
                        <Icon name="content-copy" size={18} color={theme.colors.textSecondary} />
                    </View>
                )}
            </View>

            {/* 应用信息 */}
            <View style={styles.group}>
                {renderRow(
                    'information-outline',
                    t('about.appName'),
                    undefined,
                    <Text style={styles.rowValue}>v{appVersion}</Text>
                )}
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
        marginBottom: theme.spacing.m,
        shadowColor: '#000',
        shadowOffset: { width: 0, height: 1 },
        shadowOpacity: 0.03,
        shadowRadius: 4,
        elevation: 0.5,
        overflow: 'hidden',
    },
    row: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        paddingVertical: 12,
        paddingHorizontal: theme.spacing.m,
        minHeight: 52,
    },
    rowLeft: {
        flexDirection: 'row',
        alignItems: 'center',
        flex: 1,
    },
    rowIcon: {
        marginRight: theme.spacing.m,
        width: 24,
        textAlign: 'center',
    },
    rowLabel: {
        fontSize: 16,
        color: theme.colors.text,
    },
    rowValue: {
        fontSize: 14,
        color: theme.colors.textSecondary,
        marginRight: 4,
    },
    valueWithIcon: {
        flexDirection: 'row',
        alignItems: 'center',
    },
    separator: {
        height: StyleSheet.hairlineWidth,
        backgroundColor: theme.colors.border,
        marginLeft: theme.spacing.m + 24 + theme.spacing.m,
    },
});
