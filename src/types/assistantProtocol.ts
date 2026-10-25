export type ConnectionState = 'disconnected' | 'connecting' | 'connected' | 'reconnecting' | 'error';

export type TaskExecutionState = 'idle' | 'processing' | 'awaiting_approval' | 'stopped' | 'completed' | 'error';

export interface ToolCallState {
    id: string;
    name: string;
    status: 'running' | 'done' | 'failed';
    summary?: string;
    input?: Record<string, unknown>;
    output?: string;
}

export interface ApprovalRequest {
    approvalId: string;
    prompt: string;
    toolName?: string;
    params?: Record<string, unknown>;
    status: 'pending' | 'approved' | 'rejected';
}

export interface ChatAttachment {
    type: 'image' | 'file';
    name: string;
    mimeType?: string;
    size?: number;
    /** 本地文件路径（用于冷启动后离线重试时重新读取） */
    uri?: string;
    /** base64 编码数据（用于图片或二进制文件） */
    data?: string;
    /** 纯文本内容（UTF-8） */
    content?: string;
}

export interface AssistantMessage {
    id: string;
    seq: number;
    role: 'user' | 'assistant' | 'system';
    content: string;
    timestamp: number;
    status: 'sending' | 'sent' | 'processing' | 'done' | 'error';
    toolCalls?: ToolCallState[];
    approval?: ApprovalRequest;
    errorMessage?: string;
    /** 引擎结束原因（如 max_tokens），客户端据此本地化展示截断提示 */
    stopReason?: string;
    attachments?: ChatAttachment[];
}

// 客户端发往服务端的报文
export type ClientMessage =
    | { type: 'auth'; token: string }
    | { type: 'sync'; sessionId: string; lastSeq: number }
    | {
          type: 'chat';
          sessionId: string;
          messageId: string;
          content: string;
          attachments?: ChatAttachment[];
      }
    | { type: 'approval_response'; approvalId: string; approved: boolean; reason?: string }
    | { type: 'stop'; sessionId: string }
    | { type: 'ping' };

// 服务端下发给客户端的报文
export type ServerMessage =
    | {
          type: 'auth_result';
          success: boolean;
          error?: string;
          serverInfo?: {
              version: string;
              workspace: string;
              assistantName: string;
          };
      }
    | {
          type: 'sync_result';
          sessionId: string;
          messages: AssistantMessage[];
          taskState: TaskExecutionState;
          /** 兼容旧服务端：仅返回单审批时的回退字段 */
          pendingApproval?: ApprovalRequest;
          /** 待审批队列：同一会话并发多个工具各自请求审批时按序展示 */
          pendingApprovals?: ApprovalRequest[];
          currentSeq: number;
      }
    | {
          type: 'message_ack';
          messageId: string;
          seq: number;
          status?: 'sent' | 'error';
          role?: 'user';
          content?: string;
          error?: string;
          attachments?: ChatAttachment[];
      }
    | {
          type: 'event_chunk';
          seq: number;
          sessionId: string;
          messageId: string;
          delta?: string;
          content?: string;
          toolCall?: ToolCallState;
          status?: 'thinking' | 'running_tool' | 'done' | 'error';
      }
    | {
          type: 'approval_request';
          seq: number;
          sessionId?: string;
          approvalId: string;
          prompt: string;
          toolName?: string;
          params?: Record<string, unknown>;
      }
    | {
          type: 'task_status';
          seq: number;
          sessionId: string;
          state: TaskExecutionState;
          error?: string;
          stopReason?: string;
      }
    | { type: 'pong' };

export interface ServerFileItem {
    name: string;
    path: string;
    isDirectory: boolean;
    size: number;
    mtime: number;
    extension: string;
}

export interface ServerDirectoryListing {
    currentPath: string;
    parentPath: string | null;
    items: ServerFileItem[];
    /** 目录条目过多时服务端仅返回前面的部分条目，为 true 表示已截断 */
    truncated?: boolean;
}

export interface FileSystemInfo {
    homeDir: string;
    workspaceDir: string;
    separator: string;
    platform: string;
}

