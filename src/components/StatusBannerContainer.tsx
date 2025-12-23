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
    conflictedFiles?: string[];
    uploadErrorFiles?: string[];
}

export const StatusBannerContainer: React.FC<StatusBannerContainerProps> = ({
    syncStatus,
    conflictType,
    checkSync,
    onResolveUseCloud,
    onResolveUseLocal,
    onResolveSaveCopy,
    hasFailedUpload,
    conflictedFiles = [],
    uploadErrorFiles = []
}) => {
    const navigation = useNavigation();
    const { t } = useTranslation();

    // Priority 1: Offline
    if (syncStatus === 'offline') {
        return (
            <View>
                <StatusBanner
                    visible={true}
                    message={t('preview.offlineMode') || '离线模式：当前显示本地版本，可能不是最新'}
                    type="warning"
                    onPress={checkSync}
                />
            </View>
        );
    }

    // Priority 2: Not Configured
    if (syncStatus === 'not-configured') {
        return (
            <View>
                <StatusBanner
                    visible={true}
                    message={t('statusBanner.unconfigured')}
                    type="info"
                    onPress={() => (navigation as any).navigate('MainTabs', { screen: 'Settings' })}
                />
            </View>
        );
    }

    // Priority 3: Upload Errors (Retry)
    if (uploadErrorFiles.length > 0) {
        const errorFileName = uploadErrorFiles[0].split('/').pop();
        const msg = t('statusBanner.uploadFailedShort') + `: ${errorFileName}` + (uploadErrorFiles.length > 1 ? ` (+${uploadErrorFiles.length - 1})` : '');
        return (
            <View>
                <StatusBanner
                    visible={true}
                    message={msg}
                    type="warning"
                    actions={[
                        { label: '重试', onPress: onResolveUseLocal || (() => { }) } // useLocal acts as retry for upload error
                    ]}
                />
            </View>
        );
    }

    // Priority 4: Conflicts (Resolve One by One)
    if (conflictedFiles.length > 0) {
        const conflictFileName = conflictedFiles[0].split('/').pop();
        const msg = t('statusBanner.conflict') + `: ${conflictFileName}` + (conflictedFiles.length > 1 ? ` (+${conflictedFiles.length - 1})` : '');
        return (
            <View>
                <StatusBanner
                    visible={true}
                    message={msg}
                    type="warning"
                    actions={[
                        { label: t('statusBanner.resolveUseCloud'), onPress: onResolveUseCloud || (() => { }) },
                        { label: t('statusBanner.resolveUseLocal'), onPress: onResolveUseLocal || (() => { }) },
                        { label: t('statusBanner.resolveSaveCopy'), onPress: onResolveSaveCopy || (() => { }) }
                    ]}
                />
            </View>
        );
    }

    return null;
};
