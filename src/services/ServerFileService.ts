import { useAssistantStore } from '../store/useAssistantStore';
import {
    FileSystemInfo,
    ServerDirectoryListing,
} from '../types/assistantProtocol';
import * as FileSystem from 'expo-file-system/legacy';

export class ServerFileError extends Error {
    public code?: string;
    public status?: number;

    constructor(message: string, code?: string, status?: number) {
        super(message);
        this.name = 'ServerFileError';
        this.code = code;
        this.status = status;
    }
}

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

            if (response.status === 401) {
                throw new ServerFileError('访问令牌无效或已过期，请重新配置', 'UNAUTHORIZED', 401);
            }

            if (!response.ok) {
                let errorMsg = `服务响应失败 (${response.status})`;
                let errorCode: string | undefined;
                try {
                    const errData = (await response.json()) as { error?: string; code?: string };
                    if (errData.error) {
                        errorMsg = errData.error;
                    }
                    if (errData.code) {
                        errorCode = errData.code;
                    }
                } catch {
                    // ignore json parse error
                }
                throw new ServerFileError(errorMsg, errorCode, response.status);
            }

            return (await response.json()) as T;
        } catch (err: unknown) {
            const errObj = err as Error;
            if (errObj.name === 'AbortError') {
                throw new ServerFileError('请求超时，请检查服务端连接', 'TIMEOUT', 408);
            }
            // 传输层立即失败（连接拒绝、服务器离线等）：包装为结构化错误码，供前端按语言映射
            if (!(err instanceof ServerFileError)) {
                const wrapped: any = new Error(errObj.message || 'Network request failed');
                wrapped.code = 'network';
                throw wrapped;
            }
            throw errObj;
        } finally {
            clearTimeout(timeoutId);
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
     * 保存文件内容（轻度编辑保存，支持 expectedMtime 乐观锁）
     */
    public async saveFileContent(
        targetPath: string,
        content: string,
        expectedMtime?: number
    ): Promise<{ success: boolean; mtime: number; size: number }> {
        return this.request<{ success: boolean; mtime: number; size: number }>('/api/files/content', {
            method: 'POST',
            body: { path: targetPath, content, expectedMtime },
            timeoutMs: 15000,
        });
    }

    /**
     * 下载文件到本地沙盒临时目录（用于调起系统原生分享或查看）。
     * 超时按「30 秒无进展」判定而非固定总时长：慢速链路上的大文件只要仍在传输就不中断。
     */
    public async downloadFile(remotePath: string, localDestUri: string): Promise<string> {
        const { baseUrl, token } = await this.getHttpEndpoint();
        const url = `${baseUrl}/api/files/download?path=${encodeURIComponent(remotePath)}`;

        let lastProgressAt = Date.now();
        const resumable = FileSystem.createDownloadResumable(url, localDestUri, {
            headers: {
                Authorization: `Bearer ${token}`,
            },
        }, () => {
            lastProgressAt = Date.now();
        });

        let watchdog: ReturnType<typeof setInterval> | null = null;
        const timeoutPromise = new Promise<never>((_, reject) => {
            watchdog = setInterval(() => {
                if (Date.now() - lastProgressAt > 30000) {
                    reject(new ServerFileError('文件下载超时（30 秒无进展），请检查网络或稍后重试', 'DOWNLOAD_TIMEOUT', 408));
                }
            }, 5000);
        });

        try {
            const downloadResult = await Promise.race([resumable.downloadAsync(), timeoutPromise]);
            if (downloadResult?.status !== 200) {
                const status = downloadResult?.status ?? 500;
                // 仅 401 是鉴权失败；403 可能是文件权限或符号链接边界拒绝，不能误报为令牌问题
                if (status === 401) {
                    throw new ServerFileError('鉴权失败，请检查服务端令牌配置', 'UNAUTHORIZED', status);
                }
                throw new ServerFileError(`下载失败，服务端返回状态码: ${status}`, 'DOWNLOAD_FAILED', status);
            }

            return downloadResult.uri;
        } catch (err: unknown) {
            // 中断仍在传输的下载并清理残留的部分文件，避免继续占用带宽与缓存空间
            resumable.pauseAsync().catch(() => undefined);
            try {
                await FileSystem.deleteAsync(localDestUri, { idempotent: true });
            } catch {
                // ignore
            }
            throw err;
        } finally {
            if (watchdog) clearInterval(watchdog);
        }
    }
}

export const serverFileService = ServerFileService.getInstance();
