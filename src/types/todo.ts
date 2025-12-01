export type TodoStatus = 'todo' | 'done' | 'in-progress' | 'canceled';
export type Priority = 'highest' | 'high' | 'medium' | 'low' | 'lowest' | 'none';

export interface TodoItem {
    id: string; // Combination of noteId and line index/content hash to be unique
    noteId: string;
    content: string;
    status: TodoStatus;
    priority: Priority;
    rawLine: string;
    filePath: string;

    // Dates (YYYY-MM-DD)
    completedAt?: string; // ✅
    canceledAt?: string; // ❌
    dueAt?: string; // 📅
}
