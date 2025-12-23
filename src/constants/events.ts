/**
 * 应用事件常量定义
 * 集中管理所有 DeviceEventEmitter 事件，避免循环依赖
 */

// 闪念笔记相关事件
export const FLASH_NOTES_UPDATED_EVENT = 'FLASH_NOTES_UPDATED';
export const SHARE_RECEIVED_EVENT = 'SHARE_RECEIVED_EVENT';
export const BATCH_SYNC_STATUS_CHANGED_EVENT = 'BATCH_SYNC_STATUS_CHANGED_EVENT';

// 云服务相关事件
export const UPLOAD_COMPLETED_EVENT = 'UPLOAD_COMPLETED';
export const CLOUD_INIT_COMPLETED_EVENT = 'CLOUD_INIT_COMPLETED';
