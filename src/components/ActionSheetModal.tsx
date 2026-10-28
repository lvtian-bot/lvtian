import {
    Modal,
    View,
    Text,
    StyleSheet,
    TouchableOpacity,
    TouchableWithoutFeedback,
} from 'react-native';
import Icon from '@expo/vector-icons/MaterialIcons';
import { theme } from '../utils/theme';
import { useSettingsFont } from './settings';

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

/** 居中操作弹窗：点击遮罩或返回键关闭 */
export const ActionSheetModal: React.FC<ActionSheetModalProps> = ({
    visible,
    title,
    actions,
    onCancel,
}) => {
    const font = useSettingsFont();

    if (!visible) return null;

    return (
        <Modal
            transparent
            visible={visible}
            animationType="fade"
            onRequestClose={onCancel}
        >
            <TouchableOpacity
                style={styles.overlay}
                activeOpacity={1}
                onPress={onCancel}
            >
                <TouchableWithoutFeedback>
                    <View style={styles.card}>
                        {title ? (
                            <Text style={[styles.title, { fontSize: font.chatBody }]} numberOfLines={1}>
                                {title}
                            </Text>
                        ) : null}
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
                                            size={22}
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
                                                fontSize: font.chatBody,
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
                </TouchableWithoutFeedback>
            </TouchableOpacity>
        </Modal>
    );
};

const styles = StyleSheet.create({
    overlay: {
        flex: 1,
        backgroundColor: 'rgba(15, 23, 42, 0.42)',
        justifyContent: 'center',
        alignItems: 'center',
    },
    card: {
        width: '78%',
        maxWidth: 360,
        backgroundColor: theme.colors.surface,
        borderRadius: 16,
        paddingTop: 8,
        paddingBottom: 4,
        shadowColor: '#000',
        shadowOffset: { width: 0, height: 6 },
        shadowOpacity: 0.18,
        shadowRadius: 16,
        elevation: 12,
    },
    title: {
        fontWeight: '600',
        color: theme.colors.text,
        textAlign: 'center',
        paddingHorizontal: 16,
        paddingVertical: 10,
    },
    actionsList: {},
    actionButton: {
        flexDirection: 'row',
        alignItems: 'center',
        paddingVertical: 14,
        paddingHorizontal: 20,
        minHeight: 48,
    },
    divider: {
        borderBottomWidth: StyleSheet.hairlineWidth,
        borderBottomColor: theme.colors.hairline,
    },
    icon: {
        marginRight: 16,
    },
    actionText: {
        fontWeight: '400',
        color: theme.colors.text,
    },
});
