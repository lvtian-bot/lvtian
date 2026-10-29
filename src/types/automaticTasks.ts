import type { CredentialsErrorCode } from '../services/connectionConfig';

/** Read-only JSON-facing Schedule contract; no native runtime is loaded by the App. */

interface ScheduleRecordBase {
    readonly id: string;
    readonly title: string;
    readonly prompt: string;
    readonly scheduledAt: string;
}
export type AutomaticTaskRecord = ScheduleRecordBase & (
    | { readonly kind: 'at' }
    | { readonly kind: 'after'; readonly afterSeconds: number }
    | { readonly kind: 'every'; readonly everySeconds: number }
    | { readonly kind: 'daily'; readonly time: string; readonly timeZone: string }
    | { readonly kind: 'weekly'; readonly time: string; readonly timeZone: string; readonly weekdays: number[] }
    | { readonly kind: 'cron'; readonly expression: string; readonly timeZone: string }
);
export interface AutomaticTaskDelivery {
    readonly scheduledAt: string;
    readonly deliveredAt: string;
    readonly messageId: string;
}
export type AutomaticTask = AutomaticTaskRecord & {
    readonly sessionId: string;
    readonly status: 'active' | 'inactive';
    readonly lastDelivery?: AutomaticTaskDelivery;
};
export interface AutomaticTaskHistoryOptions { limit?: number; before?: string }
/** Delivery acknowledgments, NOT execution-success history. */
export type AutomaticTaskHistory =
    | {
        readonly id: string;
        readonly records: (AutomaticTaskDelivery & { readonly prompt?: string })[];
        readonly earlierRecordsUnavailable: boolean;
        readonly earlierRecordsPruned: boolean;
        readonly retention: { readonly days: number; readonly records: number };
        readonly nextBefore?: string;
    }
    | { readonly id: string; readonly code: 'schedule_not_found' | 'delivery_cursor_not_found' };
export interface AutomaticTaskResult {
    taskId: string;
    delivery?: AutomaticTaskDelivery;
    status: 'unknown' | 'not_delivered' | 'running' | 'ended';
    turn?: number;
    /** Only ended + completed is completion evidence; never infer from delivery/inactive. */
    endReason?: string;
    assistantText: string[];
    truncated: boolean;
}
/** Preserve HTTP wrappers; consumers must discard data when generation is no longer current. */
export type AutomaticTaskResponse<T> = T & { readonly generation: number };
export interface AutomaticTaskRequestOptions { signal?: AbortSignal; timeoutMs?: number }
export interface AutomaticTaskConnection {
    serverUrl: string;
    token: string;
    /** Injected providers must change this on every identity switch, including A → B → A. */
    generation: number;
}
export type AutomaticTaskErrorCode = CredentialsErrorCode | 'connection_not_ready' | 'connection_changed' | 'invalid_endpoint'
    | 'invalid_token' | 'unauthorized' | 'forbidden' | 'invalid_input'
    | 'not_found' | 'metadata_invalid' | 'service_closed' | 'native_tasks_unavailable' | 'service_upgrading'
    | 'authentication_failed' | 'connection_failed' | 'timeout' | 'disposed' | 'remote_failed'
    | 'dispose_failed' | 'method_not_allowed' | 'network' | 'aborted' | 'redirect_blocked'
    | 'invalid_response' | 'http_error';
