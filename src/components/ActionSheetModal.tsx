import {
    Modal,
    View,
    Text,
    StyleSheet,
    TouchableOpacity,
    TouchableWithoutFeedback,
    Platform,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import Icon from '@expo/vector-icons/MaterialIcons';
import { theme } from '../utils/theme';
import { useTranslation } from 'react-i18next';

export interface ActionItem {
    label: string;
    icon?: string;
    onPress: () => void;
    destructive?: boolean;
    color?: string;
}

interface ActionSheetModalProps {
    visible: boolean;
    title?: string;
    actions: ActionItem[];
    onCancel: () => void;
}

export const ActionSheetModal: React.FC<ActionSheetModalProps> = ({
    visible,
    title,
    actions,
    onCancel,
}) => {
    const { t } = useTranslation();
    const isAndroid = Platform.OS === 'android';

    if (!visible) return null;

    const renderIOSLayout = () => (
        <SafeAreaView style={styles.contentContainer}>
            <View style={styles.groupContainer}>
                {title && (
                    <View style={styles.header}>
                        <Text style={styles.title} numberOfLines={1}>
                            {title}
                        </Text>
                    </View>
                )}
                <View style={styles.actionsList}>
                    {actions.map((action, index) => (
                        <TouchableOpacity
                            key={index}
                            style={[
                                styles.actionButton,
                                index < actions.length - 1 && styles.divider,
                            ]}
                            onPress={() => {
                                onCancel();
                                // Small delay to allow modal to close smoothly
                                setTimeout(action.onPress, 100);
                            }}
                        >
                            {action.icon && (
                                <Icon
                                    name={action.icon as any}
                                    size={24}
                                    color={
                                        action.color ||
                                        (action.destructive
                                            ? theme.colors.error
                                            : theme.colors.text)
                                    }
                                    style={styles.icon}
                                />
                            )}
                            <Text
                                style={[
                                    styles.actionText,
                                    {
                                        color:
                                            action.color ||
                                            (action.destructive
                                                ? theme.colors.error
                                                : theme.colors.text),
                                    },
                                ]}
                            >
                                {action.label}
                            </Text>
                        </TouchableOpacity>
                    ))}
                </View>
            </View>
            <TouchableOpacity style={styles.cancelButton} onPress={onCancel}>
                <Text style={styles.cancelText}>{t('common.cancel')}</Text>
            </TouchableOpacity>
        </SafeAreaView>
    );

    const renderAndroidLayout = () => (
        <View style={styles.androidContentContainer}>
            <View style={styles.dragHandleContainer}>
                <View style={styles.dragHandle} />
            </View>

            {/* Title removed per user request */}
            {/* {title && (
                <View style={styles.androidHeader}>
                    <Text style={styles.androidTitle}>{title}</Text>
                </View>
            )} */}

            <View style={styles.androidActionsList}>
                {actions.map((action, index) => (
                    <TouchableOpacity
                        key={index}
                        style={styles.androidActionButton}
                        onPress={() => {
                            onCancel();
                            setTimeout(action.onPress, 100);
                        }}
                    >
                        {action.icon && (
                            <Icon
                                name={action.icon as any}
                                size={22} // Slightly smaller icon
                                color={
                                    action.color ||
                                    (action.destructive
                                        ? theme.colors.error
                                        : theme.colors.text)
                                }
                                style={styles.icon}
                            />
                        )}
                        <Text
                            style={[
                                styles.androidActionText,
                                {
                                    color:
                                        action.color ||
                                        (action.destructive
                                            ? theme.colors.error
                                            : theme.colors.text),
                                },
                            ]}
                        >
                            {action.label}
                        </Text>
                    </TouchableOpacity>
                ))}
            </View>
        </View>
    );

    return (
        <Modal
            transparent
            visible={visible}
            animationType="fade" // Use fade for both to avoid shadow sliding up on Android
            onRequestClose={onCancel}
        >
            <TouchableOpacity
                style={styles.overlay}
                activeOpacity={1}
                onPress={onCancel}
            >
                <TouchableWithoutFeedback>
                    {isAndroid ? renderAndroidLayout() : renderIOSLayout()}
                </TouchableWithoutFeedback>
            </TouchableOpacity>
        </Modal>
    );
};

const styles = StyleSheet.create({
    overlay: {
        flex: 1,
        backgroundColor: 'rgba(0, 0, 0, 0.5)',
        justifyContent: 'flex-end',
    },
    contentContainer: {
        backgroundColor: 'transparent',
        padding: theme.spacing.s, // IOS: Keep narrow outer padding (8px)
    },
    groupContainer: {
        backgroundColor: theme.colors.surface,
        borderRadius: 14,
        overflow: 'hidden',
        marginBottom: theme.spacing.s,
    },
    header: {
        backgroundColor: theme.colors.surface,
        padding: theme.spacing.m,
        borderBottomWidth: StyleSheet.hairlineWidth,
        borderBottomColor: theme.colors.border,
        alignItems: 'center',
    },
    title: {
        fontSize: 13,
        color: theme.colors.mutedText,
        fontWeight: '600',
        textAlign: 'center',
    },
    actionsList: {
        backgroundColor: theme.colors.surface,
    },
    actionButton: {
        flexDirection: 'row',
        alignItems: 'center',
        padding: theme.spacing.m,
        backgroundColor: theme.colors.surface,
        minHeight: 56,
    },
    divider: {
        borderBottomWidth: StyleSheet.hairlineWidth,
        borderBottomColor: theme.colors.border,
    },
    icon: {
        marginRight: theme.spacing.m,
    },
    actionText: {
        fontSize: 16,
        fontWeight: '500',
    },
    cancelButton: {
        backgroundColor: theme.colors.surface,
        padding: theme.spacing.m,
        borderRadius: 12,
        alignItems: 'center',
        marginTop: 0,
        minHeight: 56,
    },
    cancelText: {
        fontSize: 16,
        fontWeight: '600',
        color: theme.colors.primary,
    },
    // -- Android Styles --
    androidContentContainer: {
        backgroundColor: theme.colors.surface,
        borderTopLeftRadius: 28,
        borderTopRightRadius: 28,
        paddingBottom: theme.spacing.xl,
        width: '100%',
        // elevation: 8, // Removed shadow per request
    },
    dragHandleContainer: {
        width: '100%',
        alignItems: 'center',
        paddingVertical: theme.spacing.l, // Increased top spacing (Distance larger)
    },
    dragHandle: {
        width: 32,
        height: 4,
        borderRadius: 2,
        backgroundColor: theme.colors.border,
        opacity: 0.8,
    },
    // Header styles kept but unused for now
    androidHeader: {
        paddingHorizontal: theme.spacing.m,
        paddingBottom: theme.spacing.m,
        alignItems: 'center',
    },
    androidTitle: {
        fontSize: 14,
        color: theme.colors.textSecondary,
        textAlign: 'center',
    },
    androidActionsList: {
        paddingHorizontal: 0,
    },
    androidActionButton: {
        flexDirection: 'row',
        alignItems: 'center',
        paddingVertical: 16, // Increased from 12 (Distance larger)
        paddingHorizontal: theme.spacing.lg, // Reverted to lg (24) per request
        minHeight: 48,
    },
    androidActionText: {
        fontSize: 14, // Reduced from 16 (Text smaller)
        fontWeight: '400',
        color: theme.colors.text,
    },
});
