import CryptoJS from 'crypto-js';

/**
 * 生成稳定的短哈希，用于把服务地址、账号、远程路径等标识编码进存储键或缓存文件名，
 * 替代有损字符清洗，避免不同标识清洗后碰撞（如 team-a 与 team_a）
 */
export const stableHash = (input: string): string => (
    CryptoJS.SHA256(input).toString().slice(0, 16)
);
