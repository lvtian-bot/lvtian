import React, { useRef, useEffect, useState } from 'react';
import {
    View,
    Text,
    StyleSheet,
    FlatList,
    NativeSyntheticEvent,
    NativeScrollEvent,
    Dimensions,
    Platform,
    DimensionValue, // Import DimensionValue type
} from 'react-native';
import { theme } from '../utils/theme';

interface WheelPickerProps {
    data: string[]; // 数据源数组
    selectedIndex: number; // 当前选中项的索引
    onValueChange: (index: number) => void; // 值改变时的回调
    itemHeight?: number; // 每一项的高度，默认为 40
    visibleItems?: number; // 可见项数量，默认为 5
    width?: DimensionValue; // 组件宽度
}

export const WheelPicker: React.FC<WheelPickerProps> = ({
    data,
    selectedIndex,
    onValueChange,
    itemHeight = 40,
    visibleItems = 5,
    width = '100%',
}) => {
    const flatListRef = useRef<FlatList>(null);
    const [isScrolling, setIsScrolling] = useState(false);

    // 计算容器高度
    const containerHeight = itemHeight * visibleItems;

    // 填充数据以使第一项和最后一项居中
    const paddingCount = Math.floor(visibleItems / 2);

    useEffect(() => {
        // Scroll to initial index on mount
        if (selectedIndex >= 0 && selectedIndex < data.length) {
            // Use setTimeout to ensure Layout is done
            setTimeout(() => {
                flatListRef.current?.scrollToOffset({
                    offset: selectedIndex * itemHeight,
                    animated: false,
                });
            }, 100);
        }
    }, []);

    // Also sync if selectedIndex changes from outside (e.g. valid date check correction)
    useEffect(() => {
        if (!isScrolling && selectedIndex >= 0 && selectedIndex < data.length) {
            flatListRef.current?.scrollToOffset({
                offset: selectedIndex * itemHeight,
                animated: true,
            });
        }
    }, [selectedIndex, itemHeight, isScrolling]);


    const handleScrollEnd = (e: NativeSyntheticEvent<NativeScrollEvent>) => {
        const offsetY = e.nativeEvent.contentOffset.y;
        const index = Math.round(offsetY / itemHeight);
        const clampedIndex = Math.max(0, Math.min(index, data.length - 1));

        if (clampedIndex !== selectedIndex) {
            onValueChange(clampedIndex);
        }
        setIsScrolling(false);
    };

    const handleScrollBegin = () => {
        setIsScrolling(true);
    };

    const getItemLayout = (_: any, index: number) => ({
        length: itemHeight,
        offset: itemHeight * index,
        index,
    });

    const renderItem = ({ item, index }: { item: string; index: number }) => {
        // Determine style based on whether it's the selected item
        // Note: Real-time scaling during scroll requires Reanimated using scroll position.
        // For simple implementation, we just style plainly or use basic distinct style.
        // We will highlight the middle area with an overlay instead of changing item style dynamically during scroll for performance/simplicity.

        return (
            <View style={[styles.item, { height: itemHeight }]}>
                <Text style={[styles.itemText, { height: itemHeight, lineHeight: itemHeight }]}>
                    {item}
                </Text>
            </View>
        );
    };

    return (
        <View style={[styles.container, { height: containerHeight, width }]}>
            {/* Selection Overlay */}
            <View
                style={[
                    styles.selectionOverlay,
                    {
                        height: itemHeight,
                        top: (containerHeight - itemHeight) / 2,
                    },
                ]}
            />

            <FlatList
                ref={flatListRef}
                data={data}
                renderItem={renderItem}
                keyExtractor={(_, index) => index.toString()}
                getItemLayout={getItemLayout}
                showsVerticalScrollIndicator={false}
                snapToInterval={itemHeight}
                decelerationRate="fast"
                onMomentumScrollEnd={handleScrollEnd}
                onScrollBeginDrag={handleScrollBegin}
                contentContainerStyle={{
                    paddingVertical: paddingCount * itemHeight,
                }}
                style={{ flex: 1, width: '100%' }} // Add style here
            />
        </View>
    );
};

const styles = StyleSheet.create({
    container: {
        position: 'relative',
        backgroundColor: 'transparent',
        overflow: 'hidden',
    },
    item: {
        justifyContent: 'center',
        alignItems: 'center',
    },
    itemText: {
        color: theme.colors.text,
        textAlign: 'center',
        fontWeight: '500',
        fontSize: 18,
    },
    selectionOverlay: {
        position: 'absolute',
        left: 0,
        right: 0,
        borderTopWidth: 1,
        borderBottomWidth: 1,
        borderColor: theme.colors.primary,
        backgroundColor: 'rgba(0,0,0,0.05)',
        pointerEvents: 'none', // Allow clicks to pass through to FlatList
    },
});
