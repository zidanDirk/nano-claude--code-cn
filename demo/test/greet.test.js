const { greet } = require('../greet-improved.js');

// 简单的测试框架
function test(description, testFn) {
    try {
        testFn();
        console.log(`✅ ${description}`);
    } catch (error) {
        console.error(`❌ ${description}`);
        console.error(`   Error: ${error.message}`);
    }
}

function expect(value) {
    return {
        toBe(expected) {
            if (value !== expected) {
                throw new Error(`Expected ${expected}, got ${value}`);
            }
        },
        toThrow(errorType) {
            try {
                value();
                throw new Error('Expected function to throw');
            } catch (error) {
                if (errorType && !(error instanceof errorType)) {
                    throw new Error(`Expected ${errorType.name}, got ${error.constructor.name}`);
                }
            }
        }
    };
}

// 运行测试
console.log('Running greet function tests...\n');

// 正常用例测试
test('should greet a person by name', () => {
    const result = greet('Alice');
    expect(result).toBe('Hello, Alice!');
});

test('should trim whitespace from name', () => {
    const result = greet('  Bob  ');
    expect(result).toBe('Hello, Bob!');
});

// 异常用例测试
test('should throw TypeError for null input', () => {
    expect(() => greet(null)).toThrow(TypeError);
});

test('should throw TypeError for number input', () => {
    expect(() => greet(123)).toThrow(TypeError);
});

test('should throw TypeError for undefined input', () => {
    expect(() => greet(undefined)).toThrow(TypeError);
});

test('should throw Error for empty string', () => {
    expect(() => greet('')).toThrow(Error);
});

test('should throw Error for whitespace-only string', () => {
    expect(() => greet('   ')).toThrow(Error);
});

console.log('\nAll tests completed!');