/**
 * Normalize file path to ensure consistency across the app
 * - Removes leading/trailing slashes
 * - Replaces multiple consecutive slashes with a single slash
 * - Returns consistent format for use as metadata keys
 */
export function normalizePath(path: string): string {
    if (!path) return '';

    // Remove leading and trailing slashes, then normalize consecutive slashes
    return path
        .replace(/^\/+/, '')      // Remove leading slashes
        .replace(/\/+$/, '')      // Remove trailing slashes
        .replace(/\/+/g, '/');    // Replace multiple slashes with single slash
}

/**
 * Check if two paths refer to the same file
 */
export function isSamePath(path1: string, path2: string): boolean {
    return normalizePath(path1) === normalizePath(path2);
}
