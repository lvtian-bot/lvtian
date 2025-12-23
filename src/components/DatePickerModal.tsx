import React, { useState, useEffect, useMemo } from 'react';
import {
    Modal,
    View,
    Text,
    StyleSheet,
    TouchableOpacity,
    TouchableWithoutFeedback,
} from 'react-native';
import { useTranslation } from 'react-i18next';
import { theme } from '../utils/theme';
import { WheelPicker } from './WheelPicker';

interface DatePickerModalProps {
    visible: boolean; // 模态框是否可见
    initialDate?: string; // 初始日期，格式 YYYY-MM-DD
    onConfirm: (date: string) => void; // 确认选择的回调
    onCancel: () => void; // 取消选择的回调
}

export const DatePickerModal: React.FC<DatePickerModalProps> = ({
    visible,
    initialDate,
    onConfirm,
    onCancel,
}) => {
    const { t } = useTranslation();

    // 如果没有初始日期，默认使用今天
    const today = new Date();
    const currentYear = today.getFullYear();
    const currentMonth = today.getMonth() + 1;
    const currentDay = today.getDate();

    // 选中的年、月、日状态
    const [selectedYear, setSelectedYear] = useState(currentYear);
    const [selectedMonth, setSelectedMonth] = useState(currentMonth);
    const [selectedDay, setSelectedDay] = useState(currentDay);

    // 当可见性改变时初始化状态

    useEffect(() => {
        if (visible) {
            let y = currentYear;
            let m = currentMonth;
            let d = currentDay;

            if (initialDate) {
                const parts = initialDate.split('-');
                if (parts.length === 3) {
                    const parsedY = parseInt(parts[0], 10);
                    const parsedM = parseInt(parts[1], 10);
                    const parsedD = parseInt(parts[2], 10);
                    if (!isNaN(parsedY)) y = parsedY;
                    if (!isNaN(parsedM)) m = parsedM;
                    if (!isNaN(parsedD)) d = parsedD;
                }
            }
            setSelectedYear(y);
            setSelectedMonth(m);
            setSelectedDay(d);
        }
    }, [visible, initialDate]);

    // Generate arrays for wheels
    const years = useMemo(() => {
        const startYear = currentYear - 5; // Allow past 5 years
        const endYear = currentYear + 10;  // Allow next 10 years
        const arr = [];
        for (let i = startYear; i <= endYear; i++) {
            arr.push(i.toString());
        }
        return arr;
    }, [currentYear]);

    const months = useMemo(() => {
        return Array.from({ length: 12 }, (_, i) => (i + 1).toString().padStart(2, '0'));
    }, []);

    const days = useMemo(() => {
        // Calculate days in selected month/year
        const daysInMonth = new Date(selectedYear, selectedMonth, 0).getDate();
        return Array.from({ length: daysInMonth }, (_, i) => (i + 1).toString().padStart(2, '0'));
    }, [selectedYear, selectedMonth]);

    // Correct selected day if it exceeds new month's days
    useEffect(() => {
        const daysInMonth = new Date(selectedYear, selectedMonth, 0).getDate();
        if (selectedDay > daysInMonth) {
            setSelectedDay(daysInMonth);
        }
    }, [selectedYear, selectedMonth]);

    const handleConfirm = () => {
        const dateStr = `${selectedYear}-${selectedMonth.toString().padStart(2, '0')}-${selectedDay.toString().padStart(2, '0')}`;
        onConfirm(dateStr);
    };

    // Find indices
    const yearIndex = years.indexOf(selectedYear.toString());
    const monthIndex = selectedMonth - 1; // 0-based
    const dayIndex = selectedDay - 1; // 0-based
    return (
        <Modal
            animationType="fade"
            transparent={true}
            visible={visible}
            onRequestClose={onCancel}
        >
            <View style={styles.modalContainer}>
                {/* Backdrop - tap to cancel */}
                <TouchableOpacity
                    style={styles.backdrop}
                    activeOpacity={1}
                    onPress={onCancel}
                />

                {/* Content - sits above backdrop */}
                <View style={styles.contentContainer}>
                    <View style={styles.header}>
                        <TouchableOpacity onPress={onCancel} style={styles.headerButton}>
                            <Text style={styles.cancelText}>{t('common.cancel') || 'Cancel'}</Text>
                        </TouchableOpacity>
                        <Text style={styles.title}>{t('common.selectDate') || 'Select Date'}</Text>
                        <TouchableOpacity onPress={handleConfirm} style={styles.headerButton}>
                            <Text style={styles.confirmText}>{t('common.confirm') || 'Confirm'}</Text>
                        </TouchableOpacity>
                    </View>

                    <View style={styles.pickerContainer}>
                        <View style={styles.column}>
                            <Text style={styles.label}>{t('date.year') || 'Year'}</Text>
                            <WheelPicker
                                data={years}
                                selectedIndex={yearIndex >= 0 ? yearIndex : 0}
                                onValueChange={(index) => setSelectedYear(parseInt(years[index] || currentYear.toString(), 10))}
                                width="100%"
                            />
                        </View>
                        <View style={styles.column}>
                            <Text style={styles.label}>{t('date.month') || 'Month'}</Text>
                            <WheelPicker
                                data={months}
                                selectedIndex={monthIndex >= 0 ? monthIndex : 0}
                                onValueChange={(index) => setSelectedMonth(index + 1)}
                                width="100%"
                            />
                        </View>
                        <View style={styles.column}>
                            <Text style={styles.label}>{t('date.day') || 'Day'}</Text>
                            <WheelPicker
                                data={days}
                                selectedIndex={dayIndex >= 0 ? dayIndex : 0}
                                onValueChange={(index) => setSelectedDay(index + 1)}
                                width="100%"
                            />
                        </View>
                    </View>
                </View>
            </View>
        </Modal>
    );
};

const styles = StyleSheet.create({
    modalContainer: {
        flex: 1,
        justifyContent: 'flex-end',
        // zIndex is not strictly needed if order is correct, but helpful
    },
    backdrop: {
        ...StyleSheet.absoluteFillObject,
        backgroundColor: 'rgba(0,0,0,0.5)',
    },
    contentContainer: {
        backgroundColor: theme.colors.surface,
        borderTopLeftRadius: 16,
        borderTopRightRadius: 16,
        paddingBottom: theme.spacing.xl,
        zIndex: 1, // Ensure above backdrop
    },
    // ... existing styles ...
    header: {
        flexDirection: 'row',
        justifyContent: 'space-between',
        alignItems: 'center',
        padding: theme.spacing.m,
        borderBottomWidth: 1,
        borderBottomColor: theme.colors.border,
    },
    title: {
        fontSize: 18,
        fontWeight: 'bold',
        color: theme.colors.text,
    },
    headerButton: {
        padding: theme.spacing.s,
    },
    cancelText: {
        color: theme.colors.textSecondary,
        fontSize: 16,
    },
    confirmText: {
        color: theme.colors.primary,
        fontSize: 16,
        fontWeight: 'bold',
    },
    pickerContainer: {
        flexDirection: 'row',
        justifyContent: 'space-between',
        paddingHorizontal: theme.spacing.m,
        paddingTop: theme.spacing.m,
    },
    column: {
        flex: 1,
        alignItems: 'center',
        marginHorizontal: 2,
    },
    label: {
        marginBottom: theme.spacing.s,
        color: theme.colors.textSecondary,
        fontSize: 12,
    },
});
