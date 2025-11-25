import React from 'react';
import { TouchableOpacity, Text, StyleSheet, View } from 'react-native';
import Icon from 'react-native-vector-icons/MaterialIcons';
import { useTranslation } from 'react-i18next';
import { FileItem } from '../services/FileSystemService';
import { theme } from '../utils/theme';

interface FileListItemProps {
    item: FileItem;
    onPress: (item: FileItem) => void;
    onLongPress?: (item: FileItem) => void; // 长按时触发
    onDelete?: (item: FileItem) => void; // 保留用于向后兼容，但建议使用 onLongPress
    isCached?: boolean; // Default true if undefined
}

export const FileListItem: React.FC<FileListItemProps> = ({ item, onPress, onLongPress, onDelete, isCached = true }) => {
    const { t } = useTranslation();
    const iconName = item.isDirectory ? 'folder' : 'description';
    // If not cached, use disabled color. Otherwise use primary for folder, textSecondary for file icon (or keep existing logic)
    const baseIconColor = item.isDirectory ? theme.colors.primary : theme.colors.textSecondary;
    const iconColor = isCached ? baseIconColor : theme.colors.mutedText || '#ccc';
    const textColor = isCached ? theme.colors.text : theme.colors.mutedText || '#ccc';

    const handleLongPress = () => {
        // 优先使用新的 onLongPress 回调
        if (onLongPress) {
            onLongPress(item);
        } else if (onDelete && !item.isDirectory) {
            // 向后兼容：如果只提供了 onDelete，则只对文件有效
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
                <Text style={[styles.name, { color: textColor }]} numberOfLines={1}>
                    {item.name}
                </Text>
                <Text style={styles.details}>
                    {item.isDirectory
                        ? t('fileItem.folder')
                        : `${(item.size / 1024).toFixed(1)} ${t('fileItem.kb')}`}{' '}
                    • {(() => {
                        const d = new Date(item.mtime);
                        const pad = (n: number) => n.toString().padStart(2, '0');
                        return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
                    })()}
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
