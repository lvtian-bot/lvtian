import React from 'react';
import {
    Modal,
    View,
    Text,
    StyleSheet,
    TouchableOpacity,
    TouchableWithoutFeedback,
    ScrollView,
    KeyboardAvoidingView,
    Platform,
} from 'react-native';
import { theme } from '../../utils/theme';
import { useSettingsFont } from './useSettingsFont';

interface SettingsSheetProps {
    visible: boolean;
    title: string;
    onClose: () => void;
    /** 为 false 时点击遮罩与返回键不关闭，用于表单提交进行中 */
    dismissable?: boolean;
    children: React.ReactNode;
}

/** 设置区居中弹窗：选项类设置的统一容器 */
export const SettingsSheet: React.FC<SettingsSheetProps> = ({
    visible,
    title,
    onClose,
    dismissable = true,
    children,
}) => {
    const font = useSettingsFont();

    const requestClose = () => {
        if (dismissable) onClose();
    };

    if (!visible) return null;

    return (
        <Modal transparent visible={visible} animationType="fade" onRequestClose={requestClose}>
            <TouchableOpacity style={styles.overlay} activeOpacity={1} onPress={requestClose}>
                <TouchableWithoutFeedback>
                    <KeyboardAvoidingView
                        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
                        style={styles.centerWrap}
                    >
                        <View style={styles.dialog}>
                            <Text style={[styles.dialogTitle, { fontSize: font.chatBody }]}>{title}</Text>
                            <ScrollView
                                keyboardShouldPersistTaps="handled"
                                contentContainerStyle={styles.dialogContent}
                            >
                                {children}
                            </ScrollView>
                        </View>
                    </KeyboardAvoidingView>
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
    centerWrap: {
        width: '86%',
        maxWidth: 400,
    },
    dialog: {
        backgroundColor: theme.colors.surface,
        borderRadius: 16,
        paddingTop: 14,
        paddingBottom: 10,
        shadowColor: '#000',
        shadowOffset: { width: 0, height: 6 },
        shadowOpacity: 0.18,
        shadowRadius: 16,
        elevation: 12,
    },
    dialogTitle: {
        fontWeight: '600',
        color: theme.colors.text,
        textAlign: 'center',
        paddingHorizontal: 18,
        paddingBottom: 10,
    },
    dialogContent: {
        paddingHorizontal: 14,
        paddingBottom: 4,
    },
});
