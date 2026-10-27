import React from 'react';
import { View, Text, StyleSheet, Modal, Pressable, ScrollView } from 'react-native';
import Icon from '@expo/vector-icons/MaterialIcons';
import { theme } from '../utils/theme';

export interface PickerOption {
    key: string;
    label: string;
    desc?: string;
}

interface OptionPickerModalProps {
    visible: boolean;
    title: string;
    options: PickerOption[];
    selectedKey?: string;
    onSelect: (option: PickerOption) => void;
    onClose: () => void;
}

/**
 * 设置页通用的底部选项弹层：点开设置行后在底部弹出选项列表，
 * 选项携带一行说明与选中标记，点击即选中并关闭。
 * 各设置二级页的“点行选值”交互共用本组件。
 */
export const OptionPickerModal: React.FC<OptionPickerModalProps> = ({
    visible,
    title,
    options,
    selectedKey,
    onSelect,
    onClose,
}) => (
    <Modal
        visible={visible}
        transparent
        animationType="slide"
        onRequestClose={onClose}
        statusBarTranslucent
    >
        <Pressable style={styles.backdrop} onPress={onClose}>
            <Pressable style={styles.sheet} onPress={(e) => e.stopPropagation()}>
                <View style={styles.sheetHeader}>
                    <Text style={styles.sheetTitle}>{title}</Text>
                    <Pressable onPress={onClose} hitSlop={8}>
                        <Icon name="close" size={22} color={theme.colors.textSecondary} />
                    </Pressable>
                </View>
                <ScrollView>
                    {options.map((option, index) => {
                        const selected = option.key === selectedKey;
                        return (
                            <Pressable
                                key={option.key}
                                style={({ pressed }) => [
                                    styles.option,
                                    pressed && styles.optionPressed,
                                    index < options.length - 1 && styles.optionSeparator,
                                ]}
                                android_ripple={{ color: '#E5E7EB' }}
                                onPress={() => {
                                    onSelect(option);
                                    onClose();
                                }}
                            >
                                <View style={styles.optionTextWrap}>
                                    <Text style={[styles.optionLabel, selected && styles.optionLabelSelected]}>
                                        {option.label}
                                    </Text>
                                    {option.desc ? (
                                        <Text style={styles.optionDesc}>{option.desc}</Text>
                                    ) : null}
                                </View>
                                {selected ? (
                                    <Icon name="check" size={20} color={theme.colors.primary} />
                                ) : null}
                            </Pressable>
                        );
                    })}
                </ScrollView>
            </Pressable>
        </Pressable>
    </Modal>
);

const styles = StyleSheet.create({
    backdrop: {
        flex: 1,
        backgroundColor: 'rgba(0, 0, 0, 0.4)',
        justifyContent: 'flex-end',
    },
    sheet: {
        backgroundColor: theme.colors.surface,
        borderTopLeftRadius: 16,
        borderTopRightRadius: 16,
        maxHeight: '70%',
        paddingBottom: 24,
    },
    sheetHeader: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        paddingHorizontal: theme.spacing.l,
        paddingVertical: theme.spacing.m,
        borderBottomWidth: StyleSheet.hairlineWidth,
        borderBottomColor: theme.colors.border,
    },
    sheetTitle: {
        fontSize: 16,
        fontWeight: 'bold',
        color: theme.colors.text,
    },
    option: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        paddingHorizontal: theme.spacing.l,
        paddingVertical: 14,
        minHeight: 56,
    },
    optionPressed: {
        backgroundColor: '#F3F4F6',
    },
    optionSeparator: {
        borderBottomWidth: StyleSheet.hairlineWidth,
        borderBottomColor: theme.colors.divider,
    },
    optionTextWrap: {
        flex: 1,
        marginRight: theme.spacing.m,
    },
    optionLabel: {
        fontSize: 15,
        color: theme.colors.text,
    },
    optionLabelSelected: {
        color: theme.colors.primary,
        fontWeight: '600',
    },
    optionDesc: {
        fontSize: 12,
        color: theme.colors.textSecondary,
        lineHeight: 17,
        marginTop: 2,
    },
});
