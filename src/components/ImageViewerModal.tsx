import React, { useState, useRef, useEffect } from 'react';
import {
    Modal,
    View,
    StyleSheet,
    TouchableOpacity,
    Dimensions,
    ActivityIndicator,
    StatusBar,
    Platform,
    PanResponder,
    Animated,
} from 'react-native';
import { useTranslation } from 'react-i18next';
import Icon from '@expo/vector-icons/MaterialIcons';

interface ImageViewerModalProps {
    visible: boolean;
    imageUri: string | null;
    onClose: () => void;
}

export const ImageViewerModal: React.FC<ImageViewerModalProps> = ({
    visible,
    imageUri,
    onClose,
}) => {
    const { t } = useTranslation();
    const [loading, setLoading] = useState(true);
    const { width: screenWidth, height: screenHeight } = Dimensions.get('window');

    const scale = useRef(new Animated.Value(1)).current;
    const translateX = useRef(new Animated.Value(0)).current;
    const translateY = useRef(new Animated.Value(0)).current;

    const scaleValue = useRef(1);
    const panValue = useRef({ x: 0, y: 0 });
    const dragStartOffset = useRef({ x: 0, y: 0 });
    const initialDistance = useRef<number | null>(null);
    const initialScale = useRef(1);
    const lastTapTime = useRef(0);
    const singleTapTimeout = useRef<NodeJS.Timeout | null>(null);

    useEffect(() => {
        const scaleSub = scale.addListener((v) => {
            scaleValue.current = v.value;
        });
        const xSub = translateX.addListener((v) => {
            panValue.current.x = v.value;
        });
        const ySub = translateY.addListener((v) => {
            panValue.current.y = v.value;
        });
        return () => {
            scale.removeListener(scaleSub);
            translateX.removeListener(xSub);
            translateY.removeListener(ySub);
            if (singleTapTimeout.current) {
                clearTimeout(singleTapTimeout.current);
            }
        };
    }, [scale, translateX, translateY]);

    useEffect(() => {
        if (!visible) {
            scale.setValue(1);
            translateX.setValue(0);
            translateY.setValue(0);
            scaleValue.current = 1;
            panValue.current = { x: 0, y: 0 };
            dragStartOffset.current = { x: 0, y: 0 };
            initialDistance.current = null;
            if (singleTapTimeout.current) {
                clearTimeout(singleTapTimeout.current);
            }
        }
    }, [visible, scale, translateX, translateY]);

    const resetPositionAndScale = () => {
        Animated.parallel([
            Animated.spring(scale, { toValue: 1, useNativeDriver: true }),
            Animated.spring(translateX, { toValue: 0, useNativeDriver: true }),
            Animated.spring(translateY, { toValue: 0, useNativeDriver: true }),
        ]).start();
    };

    const panResponder = useRef(
        PanResponder.create({
            onStartShouldSetPanResponder: () => true,
            onMoveShouldSetPanResponder: () => true,
            onPanResponderGrant: (evt) => {
                dragStartOffset.current = { x: panValue.current.x, y: panValue.current.y };
                const touches = evt.nativeEvent.touches;
                if (touches.length === 2) {
                    const dx = touches[0].pageX - touches[1].pageX;
                    const dy = touches[0].pageY - touches[1].pageY;
                    initialDistance.current = Math.sqrt(dx * dx + dy * dy);
                    initialScale.current = scaleValue.current;
                } else {
                    initialDistance.current = null;
                }
            },
            onPanResponderMove: (evt, gestureState) => {
                const touches = evt.nativeEvent.touches;
                if (touches.length === 2) {
                    // 双指捏合缩放（支持先后落指的动态初始化）
                    const dx = touches[0].pageX - touches[1].pageX;
                    const dy = touches[0].pageY - touches[1].pageY;
                    const currentDistance = Math.sqrt(dx * dx + dy * dy);
                    if (!initialDistance.current) {
                        initialDistance.current = currentDistance;
                        initialScale.current = scaleValue.current;
                    } else {
                        const newScale = Math.min(
                            Math.max(initialScale.current * (currentDistance / initialDistance.current), 0.8),
                            4
                        );
                        scale.setValue(newScale);
                    }
                } else if (touches.length === 1 && scaleValue.current > 1) {
                    // 单指拖拽平移：基于手势开始时的固定基准进行平移，避免累计位移累加漂移
                    initialDistance.current = null;
                    translateX.setValue(dragStartOffset.current.x + gestureState.dx);
                    translateY.setValue(dragStartOffset.current.y + gestureState.dy);
                }
            },
            onPanResponderRelease: (_evt, gestureState) => {
                initialDistance.current = null;
                const now = Date.now();

                // 点击判定：移动距离极小（< 8px）
                if (Math.abs(gestureState.dx) < 8 && Math.abs(gestureState.dy) < 8) {
                    if (now - lastTapTime.current < 280) {
                        // 双击判定：清除延时的单击关闭定时器，切换放大与复位
                        if (singleTapTimeout.current) {
                            clearTimeout(singleTapTimeout.current);
                            singleTapTimeout.current = null;
                        }
                        lastTapTime.current = 0;
                        if (scaleValue.current > 1.2) {
                            resetPositionAndScale();
                        } else {
                            Animated.spring(scale, { toValue: 2.5, useNativeDriver: true }).start();
                        }
                        return;
                    }
                    lastTapTime.current = now;
                    // 单击退出：若当前处于未放大状态，延时等待双击窗口，避免第一次点击过早卸载模态框
                    if (scaleValue.current <= 1.05) {
                        if (singleTapTimeout.current) {
                            clearTimeout(singleTapTimeout.current);
                        }
                        singleTapTimeout.current = setTimeout(() => {
                            onClose();
                        }, 280);
                        return;
                    }
                }

                // 缩放边界回弹
                if (scaleValue.current < 1) {
                    resetPositionAndScale();
                } else if (scaleValue.current > 3.5) {
                    Animated.spring(scale, { toValue: 3.5, useNativeDriver: true }).start();
                }
            },
        })
    ).current;

    if (!visible || !imageUri) return null;

    const topOffset = Platform.OS === 'ios' ? 48 : (StatusBar.currentHeight ? StatusBar.currentHeight + 12 : 32);

    return (
        <Modal
            visible={visible}
            transparent={true}
            animationType="fade"
            statusBarTranslucent={true}
            onRequestClose={onClose}
        >
            <View style={styles.container}>
                <StatusBar barStyle="light-content" />
                <View style={styles.gestureContainer} {...panResponder.panHandlers}>
                    <Animated.Image
                        source={{ uri: imageUri }}
                        style={[
                            styles.image,
                            {
                                width: screenWidth,
                                height: screenHeight,
                                transform: [
                                    { translateX },
                                    { translateY },
                                    { scale },
                                ],
                            },
                        ]}
                        resizeMode="contain"
                        onLoadStart={() => setLoading(true)}
                        onLoadEnd={() => setLoading(false)}
                    />
                </View>

                {loading && (
                    <View style={styles.loadingContainer} pointerEvents="none">
                        <ActivityIndicator size="large" color="#FFFFFF" />
                    </View>
                )}

                <TouchableOpacity
                    style={[
                        styles.closeButton,
                        { top: topOffset },
                    ]}
                    onPress={onClose}
                    accessibilityRole="button"
                    accessibilityLabel={t('common.close', '关闭')}
                    activeOpacity={0.7}
                >
                    <Icon name="close" size={22} color="#FFFFFF" />
                </TouchableOpacity>
            </View>
        </Modal>
    );
};

const styles = StyleSheet.create({
    container: {
        flex: 1,
        backgroundColor: 'rgba(0, 0, 0, 0.95)',
        justifyContent: 'center',
        alignItems: 'center',
    },
    gestureContainer: {
        flex: 1,
        width: '100%',
        justifyContent: 'center',
        alignItems: 'center',
    },
    image: {
        maxWidth: '100%',
        maxHeight: '100%',
    },
    loadingContainer: {
        ...StyleSheet.absoluteFill,
        justifyContent: 'center',
        alignItems: 'center',
    },
    closeButton: {
        position: 'absolute',
        right: 16,
        width: 36,
        height: 36,
        borderRadius: 18,
        backgroundColor: 'rgba(255, 255, 255, 0.25)',
        justifyContent: 'center',
        alignItems: 'center',
        zIndex: 10,
    },
});
