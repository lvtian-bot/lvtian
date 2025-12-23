import React from 'react';
import { View } from 'react-native';
import { useNavigation } from '@react-navigation/native';
import { useTranslation } from 'react-i18next';
import { StatusBanner } from './StatusBanner';
import { SyncStatus, ConflictType } from '../services/SyncService';
// import { useFileMetadataStore } from '../store/useFileMetadataStore';

interface StatusBannerContainerProps {
    syncStatus: SyncStatus;
    conflictType: ConflictType;
    checkSync: () => void;
    // Conflict resolution handlers
    onResolveUseCloud?: () => void;
    onResolveUseLocal?: () => void;
    onResolveSaveCopy?: () => void;
    // Optional file path to check metadata for (e.g. current main file)
    // If not provided, it might rely on general status or check all? 
    // Usually we check metadata for specific failed files. 
    // But syncStatus is already aggregated.
    // Let's pass the 'isFailed' state or similar if simpler.
    hasFailedUpload?: boolean;
}

export const StatusBannerContainer: React.FC<StatusBannerContainerProps> = ({
    syncStatus,
    conflictType,
    checkSync,
    onResolveUseCloud,
    onResolveUseLocal,
    onResolveSaveCopy,
    hasFailedUpload
}) => {
    const navigation = useNavigation();
    const { t } = useTranslation();

    // Helper to determine if we should show the conflict banner
    const shouldShowConflictBanner = syncStatus === 'conflict' && (
        conflictType === 'bidirectional' ||
        !conflictType ||
        hasFailedUpload
    );

    return (
        <View>
            {syncStatus === 'not-configured' && (
                <StatusBanner
                    visible={true}
                    message={'未配置云服务：当前仅使用本地存储'}
                    type="info"
                    onPress={() => (navigation as any).navigate('MainTabs', { screen: 'Settings' })}
                />
            )}
            {syncStatus === 'offline' && (
                <StatusBanner
                    visible={true}
                    message={`${t('preview.offlineMode') || '离线模式：当前显示本地版本，可能不是最新'}${hasFailedUpload ? ' (上次上传失败)' : ''}`}
                    type="warning"
                    onPress={checkSync}
                />
            )}
            {shouldShowConflictBanner && (
                <StatusBanner
                    visible={true}
                    message={hasFailedUpload
                        ? '上传失败'
                        : '本地和云端已同时修改 (冲突)'
                    }
                    type="warning"
                    actions={hasFailedUpload ? [
                        { label: '上传本地覆盖云端', onPress: onResolveUseLocal || (() => { }) }
                    ] : [
                        { label: '使用云端版本', onPress: onResolveUseCloud || (() => { }) },
                        { label: '保存副本', onPress: onResolveSaveCopy || (() => { }) },
                        { label: '上传覆盖', onPress: onResolveUseLocal || (() => { }) }
                    ]}
                />
            )}
        </View>
    );
};
