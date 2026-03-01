/**
 * 生成问候语
 * @param {string} name - 要问候的名字
 * @returns {string} 格式化的问候语
 * @throws {TypeError} 当 name 不是字符串时
 * @throws {Error} 当 name 为空字符串时
 * @example
 * // 返回 "Hello, Alice!"
 * greet('Alice');
 * @example
 * // 抛出 TypeError
 * greet(null);
 */
function greet(name) {
    // 输入验证
    if (typeof name !== 'string') {
        throw new TypeError('name must be a string');
    }
    
    // 去除空白字符并检查是否为空
    const trimmedName = name.trim();
    if (trimmedName === '') {
        throw new Error('name cannot be empty or whitespace only');
    }
    
    // 返回问候语
    return `Hello, ${trimmedName}!`;
}

// CommonJS 导出
module.exports = { greet };