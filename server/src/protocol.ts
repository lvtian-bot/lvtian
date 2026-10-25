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
    status: 'sending' | 'sent' | 'queued' | 'processing' | 'done' | 'error';
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
    | { type: 'cancel_queued'; sessionId: string; messageId: string }
    | { type: 'approval_response'; approvalId: string; approved: boolean; reason?: string }
    | { type: 'stop'; sessionId: string }
    | { type: 'ping' };

// 服务端下发给客户端的报文
/** 服务端即将升级通知 */
export interface ServiceUpgradingMessage {
    type: 'service_upgrading';
    /** 预计重启恢复所需秒数（通常为 3~5 秒） */
    estimatedSeconds: number;
    /** 即将升级的目标版本号或提交简写 */
    targetVersion?: string;
    /** 提示文案（可选，客户端优先使用本地国际化） */
    reason?: string;
}

export type ServerMessage =
    | ServiceUpgradingMessage
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
          deletedMessageIds?: string[];
          taskState: TaskExecutionState;
          /** 兼容保留：待审批队列的第一项（旧客户端仅支持单卡展示） */
          pendingApproval?: ApprovalRequest;
          /** 待审批队列全量：同一会话并发多个工具各自请求审批时按序展示 */
          pendingApprovals?: ApprovalRequest[];
          currentSeq: number;
      }
    | {
          type: 'message_ack';
          messageId: string;
          seq: number;
          status?: 'sent' | 'queued' | 'error';
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
    | {
          type: 'message_deleted';
          sessionId: string;
          messageId: string;
      }
    | { type: 'pong' };
