/**
 * 问候函数
 * @param {string} name - 要问候的名字
 * @returns {string} 问候语
 */
function greet(name) {
    return `Hello, ${name}!`;
}

// 导出 greet 函数
module.exports = { greet };