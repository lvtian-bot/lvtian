import React from 'react';
import {
    Modal,
    View,
    Text,
    StyleSheet,
    TouchableOpacity,
    TouchableWithoutFeedback,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { theme } from '../../utils/theme';

interface SettingsSheetProps {
    visible: boolean;
    title: string;
    onClose: () => void;
    /** 为 false 时点击遮罩与返回键不关闭，用于表单提交进行中 */
    dismissable?: boolean;
    children: React.ReactNode;
}

export const SettingsSheet: React.FC<SettingsSheetProps> = ({
    visible,
    title,
    onClose,
    dismissable = true,
    children,
}) => {
    if (!visible) return null;

    const requestClose = () => {
        if (dismissable) onClose();
    };

    return (
        <Modal transparent visible={visible} animationType="fade" onRequestClose={requestClose}>
            <TouchableOpacity style={styles.overlay} activeOpacity={1} onPress={requestClose}>
                <TouchableWithoutFeedback>
                    <SafeAreaView edges={['bottom']} style={styles.sheetSafe}>
                        <View style={styles.sheet}>
                            <View style={styles.handle} />
                            <Text style={styles.sheetTitle}>{title}</Text>
                            {children}
                        </View>
                    </SafeAreaView>
                </TouchableWithoutFeedback>
            </TouchableOpacity>
        </Modal>
    );
};

const styles = StyleSheet.create({
    overlay: {
        flex: 1,
        backgroundColor: 'rgba(15, 23, 42, 0.42)',
        justifyContent: 'flex-end',
    },
    sheetSafe: {
        width: '100%',
    },
    sheet: {
        backgroundColor: theme.colors.surface,
        borderTopLeftRadius: 22,
        borderTopRightRadius: 22,
        paddingTop: 6,
        paddingBottom: 8,
        shadowColor: '#000',
        shadowOffset: { width: 0, height: -6 },
        shadowOpacity: 0.12,
        shadowRadius: 16,
        elevation: 12,
    },
    handle: {
        width: 36,
        height: 4,
        borderRadius: 2,
        backgroundColor: '#E2E5EA',
        alignSelf: 'center',
        marginBottom: 2,
    },
    sheetTitle: {
        fontSize: 15,
        fontWeight: '600',
        color: theme.colors.text,
        textAlign: 'center',
        paddingHorizontal: 20,
        paddingTop: 8,
        paddingBottom: 6,
    },
});
