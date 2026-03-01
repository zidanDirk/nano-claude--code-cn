// TodoMVC 应用
class TodoMVC {
    constructor() {
        this.todos = JSON.parse(localStorage.getItem('todos')) || [];
        this.filter = 'all';
        this.init();
    }

    init() {
        this.render();
        this.bindEvents();
    }

    // 添加新的待办事项
    addTodo(title) {
        if (!title.trim()) return;
        
        const newTodo = {
            id: Date.now(),
            title: title.trim(),
            completed: false,
            editing: false
        };
        
        this.todos.push(newTodo);
        this.save();
        this.render();
    }

    // 删除待办事项
    removeTodo(id) {
        this.todos = this.todos.filter(todo => todo.id !== id);
        this.save();
        this.render();
    }

    // 切换完成状态
    toggleTodo(id) {
        this.todos = this.todos.map(todo => 
            todo.id === id ? { ...todo, completed: !todo.completed } : todo
        );
        this.save();
        this.render();
    }

    // 开始编辑
    startEditing(id) {
        this.todos = this.todos.map(todo => 
            todo.id === id ? { ...todo, editing: true } : { ...todo, editing: false }
        );
        this.render();
    }

    // 完成编辑
    finishEditing(id, newTitle) {
        if (!newTitle.trim()) {
            this.removeTodo(id);
            return;
        }
        
        this.todos = this.todos.map(todo => 
            todo.id === id ? { ...todo, title: newTitle.trim(), editing: false } : todo
        );
        this.save();
        this.render();
    }

    // 切换所有待办事项的完成状态
    toggleAll() {
        const allCompleted = this.todos.every(todo => todo.completed);
        this.todos = this.todos.map(todo => ({ ...todo, completed: !allCompleted }));
        this.save();
        this.render();
    }

    // 清除所有已完成的事项
    clearCompleted() {
        this.todos = this.todos.filter(todo => !todo.completed);
        this.save();
        this.render();
    }

    // 设置过滤器
    setFilter(filter) {
        this.filter = filter;
        this.render();
    }

    // 获取过滤后的待办事项
    getFilteredTodos() {
        switch (this.filter) {
            case 'active':
                return this.todos.filter(todo => !todo.completed);
            case 'completed':
                return this.todos.filter(todo => todo.completed);
            default:
                return this.todos;
        }
    }

    // 获取剩余未完成事项数量
    getRemainingCount() {
        return this.todos.filter(todo => !todo.completed).length;
    }

    // 保存到本地存储
    save() {
        localStorage.setItem('todos', JSON.stringify(this.todos));
    }

    // 渲染应用
    render() {
        const filteredTodos = this.getFilteredTodos();
        const remainingCount = this.getRemainingCount();
        const hasCompleted = this.todos.some(todo => todo.completed);

        // 生成 HTML
        let html = `
            <section class="todoapp">
                <header class="header">
                    <h1>todos</h1>
                    <input 
                        class="new-todo" 
                        placeholder="What needs to be done?" 
                        autofocus
                        onkeydown="if(event.key === 'Enter') app.addTodo(this.value); this.value=''"
                    >
                </header>
                
                <section class="main" ${this.todos.length === 0 ? 'style="display:none"' : ''}>
                    <input 
                        id="toggle-all" 
                        class="toggle-all" 
                        type="checkbox" 
                        ${remainingCount === 0 ? 'checked' : ''}
                        onchange="app.toggleAll()"
                    >
                    <label for="toggle-all">Mark all as complete</label>
                    
                    <ul class="todo-list">
                        ${filteredTodos.map(todo => `
                            <li class="${todo.completed ? 'completed' : ''} ${todo.editing ? 'editing' : ''}">
                                <div class="view">
                                    <input 
                                        class="toggle" 
                                        type="checkbox" 
                                        ${todo.completed ? 'checked' : ''}
                                        onchange="app.toggleTodo(${todo.id})"
                                    >
                                    <label ondblclick="app.startEditing(${todo.id})">
                                        ${this.escapeHtml(todo.title)}
                                    </label>
                                    <button class="destroy" onclick="app.removeTodo(${todo.id})"></button>
                                </div>
                                <input 
                                    class="edit" 
                                    value="${this.escapeHtml(todo.title)}"
                                    onblur="app.finishEditing(${todo.id}, this.value)"
                                    onkeydown="if(event.key === 'Enter') app.finishEditing(${todo.id}, this.value)"
                                >
                            </li>
                        `).join('')}
                    </ul>
                </section>
                
                <footer class="footer" ${this.todos.length === 0 ? 'style="display:none"' : ''}>
                    <span class="todo-count">
                        <strong>${remainingCount}</strong> item${remainingCount !== 1 ? 's' : ''} left
                    </span>
                    
                    <ul class="filters">
                        <li>
                            <a href="#/" class="${this.filter === 'all' ? 'selected' : ''}" onclick="app.setFilter('all')">All</a>
                        </li>
                        <li>
                            <a href="#/active" class="${this.filter === 'active' ? 'selected' : ''}" onclick="app.setFilter('active')">Active</a>
                        </li>
                        <li>
                            <a href="#/completed" class="${this.filter === 'completed' ? 'selected' : ''}" onclick="app.setFilter('completed')">Completed</a>
                        </li>
                    </ul>
                    
                    <button 
                        class="clear-completed" 
                        ${hasCompleted ? '' : 'style="display:none"'}
                        onclick="app.clearCompleted()"
                    >
                        Clear completed
                    </button>
                </footer>
            </section>
            
            <footer class="info">
                <p>Double-click to edit a todo</p>
                <p>Created by <a href="https://github.com">TodoMVC Team</a></p>
                <p>Part of <a href="http://todomvc.com">TodoMVC</a></p>
            </footer>
        `;

        // 更新 DOM
        const appElement = document.getElementById('app');
        if (appElement) {
            appElement.innerHTML = html;
        }
    }

    // HTML 转义
    escapeHtml(text) {
        const div = document.createElement('div');
        div.textContent = text;
        return div.innerHTML;
    }

    // 绑定事件
    bindEvents() {
        // 处理 URL 哈希变化
        window.addEventListener('hashchange', () => {
            const hash = window.location.hash.replace('#/', '');
            if (hash === 'active' || hash === 'completed') {
                this.setFilter(hash);
            } else {
                this.setFilter('all');
            }
        });

        // 初始哈希处理
        const hash = window.location.hash.replace('#/', '');
        if (hash === 'active' || hash === 'completed') {
            this.setFilter(hash);
        }
    }
}

// 创建并导出应用实例
const app = new TodoMVC();

// 导出给全局使用
window.app = app;