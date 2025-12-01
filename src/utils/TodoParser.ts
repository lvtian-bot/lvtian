import { TodoItem, TodoStatus, Priority } from '../types/todo';

export class TodoParser {
    // Regex patterns
    private static readonly TODO_REGEX = /^(\s*)-\s\[([ x/-])\]\s+(.*)$/u;
    private static readonly PRIORITY_REGEX = /([🔺⏫🔼🔽⏬])/u;


    static parse(line: string, noteId: string, filePath: string, index: number): TodoItem | null {
        const match = line.match(this.TODO_REGEX);
        if (!match) return null;

        const [, _indent, mark, contentWithTags] = match;
        // console.log(`[TodoParser] Parsing line: "${line}"`);
        // console.log(`[TodoParser] Content with tags: "${contentWithTags}"`);
        let status: TodoStatus = 'todo';

        switch (mark) {
            case 'x': status = 'done'; break;
            case '/': status = 'in-progress'; break;
            case '-': status = 'canceled'; break;
            default: status = 'todo';
        }

        let content = contentWithTags;
        let priority: Priority = 'none';
        let completedAt: string | undefined;
        let canceledAt: string | undefined;
        let dueAt: string | undefined;

        // Extract Priority
        const priorityMatch = content.match(this.PRIORITY_REGEX);
        if (priorityMatch) {
            switch (priorityMatch[1]) {
                case '🔺': priority = 'highest'; break;
                case '⏫': priority = 'high'; break;
                case '🔼': priority = 'medium'; break;
                case '🔽': priority = 'low'; break;
                case 'lowest': priority = 'lowest'; break;
            }
            content = content.replace(this.PRIORITY_REGEX, '').trim();
        }

        // Extract Dates
        // Use replace with callback to extract dates and remove them from content in one pass
        // We include 📆 (alternative calendar) and  (replacement character) to handle potential encoding issues
        // where the 4-byte emoji 📅 might be read incorrectly as .
        const DATE_REGEX = /([✅❌📅📆])\s*(\d{4}-\d{2}-\d{2})/gu;

        content = content.replace(DATE_REGEX, (dateMatch, symbol, date) => {
            switch (symbol) {
                case '✅': completedAt = date; break;
                case '❌': canceledAt = date; break;
                case '📅':
                case '📆':
                case '': 
                    dueAt = date;
                    break;
            }
            return ''; // Remove the date string from content
        }).trim();

        // Clean up extra spaces
        content = content.replace(/\s+/g, ' ').trim();

        return {
            id: `${noteId}-${index}`,
            noteId,
            content,
            status,
            priority,
            rawLine: line,
            filePath,
            completedAt,
            canceledAt,
            dueAt
        };
    }

    static serialize(item: TodoItem): string {
        let mark = ' ';
        switch (item.status) {
            case 'done': mark = 'x'; break;
            case 'in-progress': mark = '/'; break;
            case 'canceled': mark = '-'; break;
        }

        let line = `- [${mark}] ${item.content}`;

        // Add Priority
        if (item.priority !== 'none') {
            switch (item.priority) {
                case 'highest': line += ' 🔺'; break;
                case 'high': line += ' ⏫'; break;
                case 'medium': line += ' 🔼'; break;
                case 'low': line += ' 🔽'; break;
                case 'lowest': line += ' ⏬'; break;
            }
        }

        // Add Due Date
        if (item.dueAt) {
            line += ` 📅 ${item.dueAt}`;
        }

        // Add Completion/Cancellation Date
        // Only add if status matches
        if (item.status === 'done' && item.completedAt) {
            line += ` ✅ ${item.completedAt}`;
        } else if (item.status === 'canceled' && item.canceledAt) {
            line += ` ❌ ${item.canceledAt}`;
        }

        return line;
    }
}
