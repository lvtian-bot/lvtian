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
}

// 客户端发往服务端的报文
export type ClientMessage =
    | { type: 'auth'; token: string }
    | { type: 'sync'; sessionId: string; lastSeq: number }
    | { type: 'chat'; sessionId: string; messageId: string; content: string }
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
          pendingApproval?: ApprovalRequest;
          currentSeq: number;
      }
    | {
          type: 'message_ack';
          messageId: string;
          seq: number;
          status?: 'sent' | 'error';
          error?: string;
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
      }
    | { type: 'pong' };
