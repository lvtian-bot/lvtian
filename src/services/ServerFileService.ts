import { useAssistantStore } from '../store/useAssistantStore';
import {
    FileSystemInfo,
    ServerDirectoryListing,
} from '../types/assistantProtocol';
import * as FileSystem from 'expo-file-system/legacy';

export class ServerFileService {
    private static instance: ServerFileService | null = null;

    public static getInstance(): ServerFileService {
        if (!ServerFileService.instance) {
            ServerFileService.instance = new ServerFileService();
        }
        return ServerFileService.instance;
    }

    /**
     * 获取经过规范化转换的 HTTP 基础地址与鉴权 Token
     */
    private async getHttpEndpoint(): Promise<{ baseUrl: string; token: string }> {
        const store = useAssistantStore.getState();
        let url = store.serverUrl;
        let token = store.serverToken;

        // 如果 store 里暂无 token，尝试异步从 SecureStore 读取
        if (!token) {
            const creds = await store.loadSavedCredentials();
            url = creds.url || url;
            token = creds.token || token;
        }

        const cleanUrl = (url || '').trim().replace(/\/+$/, '');
        if (!cleanUrl) {
            throw new Error('未配置助理服务地址');
        }

        const httpUrl = cleanUrl
            .replace(/^ws:\/\//i, 'http://')
            .replace(/^wss:\/\//i, 'https://');

        return { baseUrl: httpUrl, token: token.trim() };
    }

    /**
     * 统一发起鉴权 HTTP 请求
     */
    private async request<T>(
        path: string,
        options: {
            method?: string;
            body?: unknown;
            timeoutMs?: number;
        } = {}
    ): Promise<T> {
        const { baseUrl, token } = await this.getHttpEndpoint();
        const url = `${baseUrl}${path}`;
        const method = options.method || 'GET';
        const timeoutMs = options.timeoutMs || 10000;

        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

        const headers: Record<string, string> = {
            Authorization: `Bearer ${token}`,
        };

        let requestBody: string | undefined;
        if (options.body !== undefined) {
            headers['Content-Type'] = 'application/json';
            requestBody = JSON.stringify(options.body);
        }

        try {
            const response = await fetch(url, {
                method,
                headers,
                body: requestBody,
                signal: controller.signal,
            });

            clearTimeout(timeoutId);

            if (response.status === 401) {
                throw new Error('访问令牌无效或已过期，请重新配置');
            }

            if (!response.ok) {
                let errorMsg = `服务响应失败 (${response.status})`;
                try {
                    const errData = (await response.json()) as { error?: string };
                    if (errData.error) {
                        errorMsg = errData.error;
                    }
                } catch {
                    // ignore json parse error
                }
                throw new Error(errorMsg);
            }

            return (await response.json()) as T;
        } catch (err: unknown) {
            clearTimeout(timeoutId);
            const errObj = err as Error;
            if (errObj.name === 'AbortError') {
                throw new Error('请求超时，请检查服务端连接');
            }
            throw errObj;
        }
    }

    /**
     * 获取服务端环境信息（主目录、工作区等）
     */
    public async getSystemInfo(): Promise<FileSystemInfo> {
        return this.request<FileSystemInfo>('/api/files/info');
    }

    /**
     * 列出目录内容
     */
    public async listDirectory(targetPath?: string): Promise<ServerDirectoryListing> {
        const query = targetPath ? `?path=${encodeURIComponent(targetPath)}` : '';
        return this.request<ServerDirectoryListing>(`/api/files/list${query}`);
    }

    /**
     * 读取文本文件内容（用于预览与轻度编辑）
     */
    public async readFileContent(targetPath: string): Promise<{ content: string; mtime: number; size: number }> {
        const query = `?path=${encodeURIComponent(targetPath)}`;
        return this.request<{ content: string; mtime: number; size: number }>(`/api/files/content${query}`);
    }

    /**
     * 保存文件内容（轻度编辑保存）
     */
    public async saveFileContent(
        targetPath: string,
        content: string
    ): Promise<{ success: boolean; mtime: number; size: number }> {
        return this.request<{ success: boolean; mtime: number; size: number }>('/api/files/content', {
            method: 'POST',
            body: { path: targetPath, content },
            timeoutMs: 15000,
        });
    }

    /**
     * 下载文件到本地沙盒临时目录（用于调起系统原生分享或查看）
     */
    public async downloadFile(remotePath: string, localDestUri: string): Promise<string> {
        const { baseUrl, token } = await this.getHttpEndpoint();
        const url = `${baseUrl}/api/files/download?path=${encodeURIComponent(remotePath)}`;

        const downloadResult = await FileSystem.downloadAsync(url, localDestUri, {
            headers: {
                Authorization: `Bearer ${token}`,
            },
        });

        if (downloadResult.status !== 200) {
            throw new Error(`下载失败，服务端返回状态码: ${downloadResult.status}`);
        }

        return downloadResult.uri;
    }
}

export const serverFileService = ServerFileService.getInstance();
