import React from 'react';
import { View, Text, TouchableOpacity, StyleSheet, ScrollView } from 'react-native';
import { useTranslation } from 'react-i18next';
import { theme } from '../utils/theme';
import Icon from 'react-native-vector-icons/MaterialIcons';

interface BreadcrumbProps {
    path: string;
    onPathPress: (newPath: string) => void;
}

export const Breadcrumb: React.FC<BreadcrumbProps> = ({ path, onPathPress }) => {
    const { t } = useTranslation();
    const pathSegments = path.split('/').filter(Boolean);

    const handlePress = (index: number) => {
        if (index < 0) {
            // Root path
            onPathPress('');
        } else {
            const newPath = pathSegments.slice(0, index + 1).join('/') + '/';
            onPathPress(newPath);
        }
    };

    return (
        <View style={styles.container}>
            <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.scrollContainer}>
                <TouchableOpacity onPress={() => handlePress(-1)} style={styles.segment}>
                    <Icon name="home" size={20} color={theme.colors.primary} />
                    <Text style={styles.pathText}>{t('browser.root')}</Text>
                </TouchableOpacity>

                {pathSegments.map((segment, index) => (
                    <React.Fragment key={index}>
                        <Icon name="chevron-right" size={20} color={theme.colors.textSecondary} style={styles.separator} />
                        <TouchableOpacity
                            onPress={() => handlePress(index)}
                            style={styles.segment}
                            disabled={index === pathSegments.length - 1} // Disable press on last segment
                        >
                            <Text style={[
                                styles.pathText,
                                index === pathSegments.length - 1 && styles.currentPathText
                            ]}>
                                {segment}
                            </Text>
                        </TouchableOpacity>
                    </React.Fragment>
                ))}
            </ScrollView>
        </View>
    );
};

const styles = StyleSheet.create({
    container: {
        flexDirection: 'row',
        alignItems: 'center',
        backgroundColor: theme.colors.background,
        paddingHorizontal: theme.spacing.m,
        paddingVertical: theme.spacing.xs,
        borderBottomWidth: 1,
        borderBottomColor: theme.colors.border,
    },
    scrollContainer: {
        alignItems: 'center',
    },
    segment: {
        flexDirection: 'row',
        alignItems: 'center',
    },
    pathText: {
        fontSize: 14,
        color: theme.colors.primary,
    },
    currentPathText: {
        color: theme.colors.text,
        fontWeight: 'bold',
    },
    separator: {
        marginHorizontal: theme.spacing.xs,
    },
});
