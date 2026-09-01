/**
 * 密码哈希工具
 * 使用固定盐 + SHA-256 进行单向哈希，增加彩虹表攻击难度
 * 注意：这仅用于本地密码保护场景，不适合服务端认证
 */

const PASSWORD_SALT = 'jacky-pg-2026';

/**
 * 将字符串转换为加盐 SHA-256 哈希值
 */
export async function hashPassword(password: string): Promise<string> {
    const encoder = new TextEncoder();
    const salted = PASSWORD_SALT + password;
    const data = encoder.encode(salted);
    const hashBuffer = await crypto.subtle.digest('SHA-256', data);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    const hashHex = hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
    return hashHex;
}

/**
 * 验证密码是否匹配哈希值
 */
export async function verifyPassword(password: string, hash: string): Promise<boolean> {
    const inputHash = await hashPassword(password);
    return inputHash === hash;
}
