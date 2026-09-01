/**
 * 生成兼容的 UUID v4
 * 在不支持 crypto.randomUUID 的环境中使用 crypto.getRandomValues 作为降级方案
 */
export function generateUUID(): string {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) {
    try {
      return crypto.randomUUID();
    } catch {
      // 在非安全上下文中会抛出错误，使用降级方案
    }
  }

  // 降级方案：使用 crypto.getRandomValues
  if (typeof crypto !== 'undefined' && crypto.getRandomValues) {
    const array = new Uint8Array(16);
    crypto.getRandomValues(array);

    // 设置 UUID v4 的标志位
    array[6] = (array[6] & 0x0f) | 0x40; // 版本 4
    array[8] = (array[8] & 0x3f) | 0x80; // 变体 10

    const hex = Array.from(array, byte => byte.toString(16).padStart(2, '0'));

    return (
      hex.slice(0, 4).join('') +
      '-' +
      hex.slice(4, 6).join('') +
      '-' +
      hex.slice(6, 8).join('') +
      '-' +
      hex.slice(8, 10).join('') +
      '-' +
      hex.slice(10, 16).join('')
    );
  }

  // 最后的降级方案：使用 Math.random（不推荐，但保证兼容性）
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function (c) {
    const r = (Math.random() * 16) | 0;
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}
