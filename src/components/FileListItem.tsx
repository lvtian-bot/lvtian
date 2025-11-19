import React from 'react';
import { TouchableOpacity, Text, StyleSheet, View } from 'react-native';
import Icon from 'react-native-vector-icons/MaterialIcons';
import { useTranslation } from 'react-i18next';
import { FileItem } from '../services/FileSystemService';
import { theme } from '../utils/theme';

interface FileListItemProps {
    item: FileItem;
    onPress: (item: FileItem) => void;
    onDelete?: (item: FileItem) => void; // Now will be triggered by long press
}

export const FileListItem: React.FC<FileListItemProps> = ({ item, onPress, onDelete }) => {
    const { t } = useTranslation();
    const iconName = item.isDirectory ? 'folder' : 'description';
    const iconColor = item.isDirectory ? theme.colors.primary : theme.colors.textSecondary;

    const handleLongPress = () => {
        if (onDelete && !item.isDirectory) { // Only call onDelete for files
            onDelete(item);
        }
    };

    return (
        <TouchableOpacity
            style={styles.container}
            onPress={() => onPress(item)}
            onLongPress={handleLongPress}
            delayLongPress={500} // Optional: Add a delay for long press
        >
            <View style={styles.iconContainer}>
                <Icon name={iconName} size={28} color={iconColor} />
            </View>
            <View style={styles.contentContainer}>
                <Text style={styles.name} numberOfLines={1}>
                    {item.name}
                </Text>
                <Text style={styles.details}>
                    {item.isDirectory
                        ? t('fileItem.folder')
                        : `${(item.size / 1024).toFixed(1)} ${t('fileItem.kb')}`}{' '}
                    • {new Date(item.mtime).toLocaleDateString()}
                </Text>
            </View>
            {/* The explicit delete button is removed */}
        </TouchableOpacity>
    );
};

const styles = StyleSheet.create({
    container: {
        flexDirection: 'row',
        padding: theme.spacing.m,
        borderBottomWidth: 1,
        borderBottomColor: theme.colors.border,
        backgroundColor: theme.colors.surface,
        alignItems: 'center',
    },
    iconContainer: {
        marginRight: theme.spacing.m,
        width: 40,
        alignItems: 'center',
    },
    contentContainer: {
        flex: 1,
    },
    name: {
        fontSize: theme.typography.body.fontSize,
        color: theme.colors.text,
        marginBottom: 4,
    },
    details: {
        fontSize: theme.typography.caption.fontSize,
        color: theme.colors.textSecondary,
    },
});
