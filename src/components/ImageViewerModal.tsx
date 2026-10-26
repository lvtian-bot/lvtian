import React, { useState } from 'react';
import {
    Modal,
    View,
    StyleSheet,
    TouchableOpacity,
    Image,
    Dimensions,
    ActivityIndicator,
    ScrollView,
    StatusBar,
    Platform,
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
                <ScrollView
                    style={styles.scrollView}
                    contentContainerStyle={[styles.scrollContent, { width: screenWidth, height: screenHeight }]}
                    maximumZoomScale={3}
                    minimumZoomScale={1}
                    showsHorizontalScrollIndicator={false}
                    showsVerticalScrollIndicator={false}
                    centerContent={true}
                >
                    <TouchableOpacity
                        activeOpacity={1}
                        style={styles.touchableArea}
                        onPress={onClose}
                    >
                        <Image
                            source={{ uri: imageUri }}
                            style={[styles.image, { width: screenWidth, height: screenHeight }]}
                            resizeMode="contain"
                            onLoadStart={() => setLoading(true)}
                            onLoadEnd={() => setLoading(false)}
                        />
                    </TouchableOpacity>
                </ScrollView>

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
    scrollView: {
        flex: 1,
        width: '100%',
    },
    scrollContent: {
        justifyContent: 'center',
        alignItems: 'center',
    },
    touchableArea: {
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
