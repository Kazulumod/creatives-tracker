const express = require('express');
const initSqlJs = require('sql.js');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const { OAuth2Client } = require('google-auth-library');

const app = express();
const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'creatives-tracker-secret-key-change-in-production';
const INVITE_CODE = process.env.INVITE_CODE || 'CREATIVES2026';
const DB_PATH = path.join(__dirname, 'creatives-tracker.db');

// Google OAuth Client ID - Replace with your own from Google Cloud Console
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || 'YOUR_GOOGLE_CLIENT_ID';
const googleClient = new OAuth2Client(GOOGLE_CLIENT_ID);

let db;

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Initialize Database
async function initDatabase() {
    const SQL = await initSqlJs();

    // Load existing database or create new one
    if (fs.existsSync(DB_PATH)) {
        const fileBuffer = fs.readFileSync(DB_PATH);
        db = new SQL.Database(fileBuffer);
    } else {
        db = new SQL.Database();
    }

    // Create tables
    db.run(`
        CREATE TABLE IF NOT EXISTS users (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL,
            email TEXT UNIQUE NOT NULL,
            password TEXT NOT NULL,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )
    `);

    db.run(`
        CREATE TABLE IF NOT EXISTS projects (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL,
            color TEXT DEFAULT '#6366f1',
            owner_id INTEGER NOT NULL,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (owner_id) REFERENCES users(id)
        )
    `);

    db.run(`
        CREATE TABLE IF NOT EXISTS project_members (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            project_id INTEGER NOT NULL,
            user_id INTEGER NOT NULL,
            role TEXT DEFAULT 'member',
            invited_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
            FOREIGN KEY (user_id) REFERENCES users(id),
            UNIQUE(project_id, user_id)
        )
    `);

    db.run(`
        CREATE TABLE IF NOT EXISTS tasks (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            key TEXT NOT NULL,
            summary TEXT NOT NULL,
            description TEXT DEFAULT '',
            status TEXT DEFAULT 'todo',
            priority TEXT DEFAULT 'medium',
            project_id INTEGER NOT NULL,
            assignee_id INTEGER,
            creator_id INTEGER NOT NULL,
            due_date TEXT,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
            FOREIGN KEY (assignee_id) REFERENCES users(id),
            FOREIGN KEY (creator_id) REFERENCES users(id)
        )
    `);

    db.run(`
        CREATE TABLE IF NOT EXISTS task_counter (
            project_id INTEGER PRIMARY KEY,
            counter INTEGER DEFAULT 0,
            FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
        )
    `);

    saveDatabase();
    console.log('Database initialized');
}

function saveDatabase() {
    const data = db.export();
    const buffer = Buffer.from(data);
    fs.writeFileSync(DB_PATH, buffer);
}

// Helper to run queries
function dbRun(sql, params = []) {
    db.run(sql, params);
    saveDatabase();
}

function dbGet(sql, params = []) {
    const stmt = db.prepare(sql);
    stmt.bind(params);
    if (stmt.step()) {
        const row = stmt.getAsObject();
        stmt.free();
        return row;
    }
    stmt.free();
    return null;
}

function dbAll(sql, params = []) {
    const stmt = db.prepare(sql);
    stmt.bind(params);
    const results = [];
    while (stmt.step()) {
        results.push(stmt.getAsObject());
    }
    stmt.free();
    return results;
}

function dbInsert(sql, params = []) {
    db.run(sql, params);
    const result = db.exec("SELECT last_insert_rowid() as id")[0];
    saveDatabase();
    return result.values[0][0];
}

// Auth Middleware
const authenticate = (req, res, next) => {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return res.status(401).json({ error: 'No token provided' });
    }

    const token = authHeader.split(' ')[1];
    try {
        const decoded = jwt.verify(token, JWT_SECRET);
        req.user = decoded;
        next();
    } catch (err) {
        return res.status(401).json({ error: 'Invalid token' });
    }
};

// ============== AUTH ROUTES ==============

// Sign Up
app.post('/api/auth/signup', async (req, res) => {
    try {
        const { name, email, password, inviteCode } = req.body;

        if (!inviteCode || inviteCode !== INVITE_CODE) {
            return res.status(403).json({ error: 'Invalid invite code. Contact your team admin.' });
        }

        if (!name || !email || !password) {
            return res.status(400).json({ error: 'Name, email, and password are required' });
        }

        if (password.length < 6) {
            return res.status(400).json({ error: 'Password must be at least 6 characters' });
        }

        // Check if user exists
        const existingUser = dbGet('SELECT id FROM users WHERE email = ?', [email.toLowerCase()]);
        if (existingUser) {
            return res.status(400).json({ error: 'An account with this email already exists' });
        }

        // Hash password
        const hashedPassword = await bcrypt.hash(password, 10);

        // Create user
        const userId = dbInsert(
            'INSERT INTO users (name, email, password) VALUES (?, ?, ?)',
            [name, email.toLowerCase(), hashedPassword]
        );

        // Create default projects for the user
        const defaultProjects = [
            { name: 'Personal', color: '#8b5cf6' },
            { name: 'Work', color: '#10b981' },
            { name: 'Ideas', color: '#f59e0b' }
        ];

        for (const project of defaultProjects) {
            const projId = dbInsert(
                'INSERT INTO projects (name, color, owner_id) VALUES (?, ?, ?)',
                [project.name, project.color, userId]
            );
            dbRun('INSERT INTO project_members (project_id, user_id, role) VALUES (?, ?, ?)',
                [projId, userId, 'owner']);
            dbRun('INSERT INTO task_counter (project_id, counter) VALUES (?, 0)', [projId]);
        }

        // Generate token
        const token = jwt.sign({ id: userId, email: email.toLowerCase() }, JWT_SECRET, { expiresIn: '7d' });

        const user = dbGet('SELECT id, name, email, created_at FROM users WHERE id = ?', [userId]);

        res.status(201).json({ user, token });
    } catch (err) {
        console.error('Signup error:', err);
        res.status(500).json({ error: 'Server error' });
    }
});

// Login
app.post('/api/auth/login', async (req, res) => {
    try {
        const { email, password } = req.body;

        if (!email || !password) {
            return res.status(400).json({ error: 'Email and password are required' });
        }

        // Find user
        const user = dbGet('SELECT * FROM users WHERE email = ?', [email.toLowerCase()]);
        if (!user) {
            return res.status(401).json({ error: 'Invalid email or password' });
        }

        // Check password
        const validPassword = await bcrypt.compare(password, user.password);
        if (!validPassword) {
            return res.status(401).json({ error: 'Invalid email or password' });
        }

        // Generate token
        const token = jwt.sign({ id: user.id, email: user.email }, JWT_SECRET, { expiresIn: '7d' });

        res.json({
            user: { id: user.id, name: user.name, email: user.email, created_at: user.created_at },
            token
        });
    } catch (err) {
        console.error('Login error:', err);
        res.status(500).json({ error: 'Server error' });
    }
});

// Google Sign-In
app.post('/api/auth/google', async (req, res) => {
    try {
        const { credential } = req.body;

        if (!credential) {
            return res.status(400).json({ error: 'Google credential is required' });
        }

        // Verify the Google token
        const ticket = await googleClient.verifyIdToken({
            idToken: credential,
            audience: GOOGLE_CLIENT_ID
        });

        const payload = ticket.getPayload();
        const { email, name, sub: googleId } = payload;

        if (!email) {
            return res.status(400).json({ error: 'Email not provided by Google' });
        }

        // Check if user exists
        let user = dbGet('SELECT * FROM users WHERE email = ?', [email.toLowerCase()]);

        if (!user) {
            // Create new user with Google account
            // Generate a random password (user won't need it for Google login)
            const randomPassword = await bcrypt.hash(Math.random().toString(36), 10);

            const userId = dbInsert(
                'INSERT INTO users (name, email, password) VALUES (?, ?, ?)',
                [name || email.split('@')[0], email.toLowerCase(), randomPassword]
            );

            // Create default projects for the user
            const defaultProjects = [
                { name: 'Personal', color: '#8b5cf6' },
                { name: 'Work', color: '#10b981' },
                { name: 'Ideas', color: '#f59e0b' }
            ];

            for (const project of defaultProjects) {
                const projId = dbInsert(
                    'INSERT INTO projects (name, color, owner_id) VALUES (?, ?, ?)',
                    [project.name, project.color, userId]
                );
                dbRun('INSERT INTO project_members (project_id, user_id, role) VALUES (?, ?, ?)',
                    [projId, userId, 'owner']);
                dbRun('INSERT INTO task_counter (project_id, counter) VALUES (?, 0)', [projId]);
            }

            user = dbGet('SELECT * FROM users WHERE id = ?', [userId]);
        }

        // Generate token
        const token = jwt.sign({ id: user.id, email: user.email }, JWT_SECRET, { expiresIn: '7d' });

        res.json({
            user: { id: user.id, name: user.name, email: user.email, created_at: user.created_at },
            token
        });
    } catch (err) {
        console.error('Google auth error:', err);
        res.status(401).json({ error: 'Invalid Google credential' });
    }
});

// Get current user
app.get('/api/auth/me', authenticate, (req, res) => {
    const user = dbGet('SELECT id, name, email, created_at FROM users WHERE id = ?', [req.user.id]);
    if (!user) {
        return res.status(404).json({ error: 'User not found' });
    }
    res.json(user);
});

// ============== PROJECT ROUTES ==============

// Get all projects for user
app.get('/api/projects', authenticate, (req, res) => {
    const projects = dbAll(`
        SELECT p.*, pm.role,
               (SELECT COUNT(*) FROM tasks WHERE project_id = p.id) as task_count,
               u.name as owner_name
        FROM projects p
        JOIN project_members pm ON p.id = pm.project_id
        JOIN users u ON p.owner_id = u.id
        WHERE pm.user_id = ?
        ORDER BY p.created_at ASC
    `, [req.user.id]);

    res.json(projects);
});

// Create project
app.post('/api/projects', authenticate, (req, res) => {
    const { name, color } = req.body;

    if (!name) {
        return res.status(400).json({ error: 'Project name is required' });
    }

    const projectId = dbInsert(
        'INSERT INTO projects (name, color, owner_id) VALUES (?, ?, ?)',
        [name, color || '#6366f1', req.user.id]
    );

    // Add owner as member
    dbRun('INSERT INTO project_members (project_id, user_id, role) VALUES (?, ?, ?)',
        [projectId, req.user.id, 'owner']);

    // Initialize task counter
    dbRun('INSERT INTO task_counter (project_id, counter) VALUES (?, 0)', [projectId]);

    const project = dbGet('SELECT * FROM projects WHERE id = ?', [projectId]);
    res.status(201).json(project);
});

// Get project members
app.get('/api/projects/:id/members', authenticate, (req, res) => {
    const projectId = req.params.id;

    // Check if user has access
    const member = dbGet('SELECT * FROM project_members WHERE project_id = ? AND user_id = ?',
        [projectId, req.user.id]);
    if (!member) {
        return res.status(403).json({ error: 'Access denied' });
    }

    const members = dbAll(`
        SELECT u.id, u.name, u.email, pm.role, pm.invited_at
        FROM project_members pm
        JOIN users u ON pm.user_id = u.id
        WHERE pm.project_id = ?
    `, [projectId]);

    res.json(members);
});

// Invite member to project
app.post('/api/projects/:id/invite', authenticate, (req, res) => {
    const projectId = req.params.id;
    const { email } = req.body;

    if (!email) {
        return res.status(400).json({ error: 'Email is required' });
    }

    // Check if user is owner
    const project = dbGet('SELECT * FROM projects WHERE id = ? AND owner_id = ?',
        [projectId, req.user.id]);
    if (!project) {
        return res.status(403).json({ error: 'Only project owners can invite members' });
    }

    // Find user to invite
    const userToInvite = dbGet('SELECT id, name, email FROM users WHERE email = ?',
        [email.toLowerCase()]);
    if (!userToInvite) {
        return res.status(404).json({ error: 'User not found. They need to sign up first.' });
    }

    // Check if already a member
    const existingMember = dbGet('SELECT * FROM project_members WHERE project_id = ? AND user_id = ?',
        [projectId, userToInvite.id]);
    if (existingMember) {
        return res.status(400).json({ error: 'User is already a member of this project' });
    }

    // Add member
    dbRun('INSERT INTO project_members (project_id, user_id, role) VALUES (?, ?, ?)',
        [projectId, userToInvite.id, 'member']);

    res.json({ message: 'Member invited successfully', user: userToInvite });
});

// Remove member from project
app.delete('/api/projects/:id/members/:userId', authenticate, (req, res) => {
    const projectId = req.params.id;
    const userIdToRemove = parseInt(req.params.userId);

    // Check if user is owner
    const project = dbGet('SELECT * FROM projects WHERE id = ? AND owner_id = ?',
        [projectId, req.user.id]);
    if (!project) {
        return res.status(403).json({ error: 'Only project owners can remove members' });
    }

    // Can't remove owner
    if (userIdToRemove === req.user.id) {
        return res.status(400).json({ error: 'Cannot remove yourself as owner' });
    }

    dbRun('DELETE FROM project_members WHERE project_id = ? AND user_id = ?',
        [projectId, userIdToRemove]);

    res.json({ message: 'Member removed successfully' });
});

// Delete project
app.delete('/api/projects/:id', authenticate, (req, res) => {
    const projectId = req.params.id;

    // Check if user is owner
    const project = dbGet('SELECT * FROM projects WHERE id = ? AND owner_id = ?',
        [projectId, req.user.id]);
    if (!project) {
        return res.status(403).json({ error: 'Only project owners can delete projects' });
    }

    dbRun('DELETE FROM tasks WHERE project_id = ?', [projectId]);
    dbRun('DELETE FROM project_members WHERE project_id = ?', [projectId]);
    dbRun('DELETE FROM task_counter WHERE project_id = ?', [projectId]);
    dbRun('DELETE FROM projects WHERE id = ?', [projectId]);

    res.json({ message: 'Project deleted successfully' });
});

// ============== TASK ROUTES ==============

// Get all tasks for user (across all their projects)
app.get('/api/tasks', authenticate, (req, res) => {
    const { project_id, status, priority } = req.query;

    let query = `
        SELECT t.*, p.name as project_name, p.color as project_color,
               creator.name as creator_name,
               assignee.name as assignee_name
        FROM tasks t
        JOIN projects p ON t.project_id = p.id
        JOIN project_members pm ON p.id = pm.project_id
        JOIN users creator ON t.creator_id = creator.id
        LEFT JOIN users assignee ON t.assignee_id = assignee.id
        WHERE pm.user_id = ?
    `;

    const params = [req.user.id];

    if (project_id) {
        query += ' AND t.project_id = ?';
        params.push(project_id);
    }

    if (status && status !== 'all') {
        query += ' AND t.status = ?';
        params.push(status);
    }

    if (priority && priority !== 'all') {
        query += ' AND t.priority = ?';
        params.push(priority);
    }

    query += ' ORDER BY t.created_at DESC';

    const tasks = dbAll(query, params);
    res.json(tasks);
});

// Create task
app.post('/api/tasks', authenticate, (req, res) => {
    const { summary, description, status, priority, project_id, assignee_id, due_date } = req.body;

    if (!summary || !project_id) {
        return res.status(400).json({ error: 'Summary and project are required' });
    }

    // Check if user has access to project
    const member = dbGet('SELECT * FROM project_members WHERE project_id = ? AND user_id = ?',
        [project_id, req.user.id]);
    if (!member) {
        return res.status(403).json({ error: 'Access denied to this project' });
    }

    // Get and increment task counter
    const counter = dbGet('SELECT counter FROM task_counter WHERE project_id = ?', [project_id]);
    const newCounter = (counter?.counter || 0) + 1;
    dbRun('UPDATE task_counter SET counter = ? WHERE project_id = ?', [newCounter, project_id]);

    // Get project prefix
    const project = dbGet('SELECT name FROM projects WHERE id = ?', [project_id]);
    const prefix = project.name.substring(0, 3).toUpperCase();
    const taskKey = `${prefix}-${newCounter}`;

    const taskId = dbInsert(`
        INSERT INTO tasks (key, summary, description, status, priority, project_id, assignee_id, creator_id, due_date)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [
        taskKey,
        summary,
        description || '',
        status || 'todo',
        priority || 'medium',
        project_id,
        assignee_id || null,
        req.user.id,
        due_date || null
    ]);

    const task = dbGet(`
        SELECT t.*, p.name as project_name, p.color as project_color,
               creator.name as creator_name,
               assignee.name as assignee_name
        FROM tasks t
        JOIN projects p ON t.project_id = p.id
        JOIN users creator ON t.creator_id = creator.id
        LEFT JOIN users assignee ON t.assignee_id = assignee.id
        WHERE t.id = ?
    `, [taskId]);

    res.status(201).json(task);
});

// Update task
app.put('/api/tasks/:id', authenticate, (req, res) => {
    const taskId = req.params.id;
    const { summary, description, status, priority, assignee_id, due_date } = req.body;

    // Check if user has access
    const task = dbGet(`
        SELECT t.* FROM tasks t
        JOIN project_members pm ON t.project_id = pm.project_id
        WHERE t.id = ? AND pm.user_id = ?
    `, [taskId, req.user.id]);

    if (!task) {
        return res.status(404).json({ error: 'Task not found or access denied' });
    }

    dbRun(`
        UPDATE tasks SET
            summary = COALESCE(?, summary),
            description = COALESCE(?, description),
            status = COALESCE(?, status),
            priority = COALESCE(?, priority),
            assignee_id = ?,
            due_date = ?,
            updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
    `, [
        summary,
        description,
        status,
        priority,
        assignee_id !== undefined ? assignee_id : task.assignee_id,
        due_date !== undefined ? due_date : task.due_date,
        taskId
    ]);

    const updatedTask = dbGet(`
        SELECT t.*, p.name as project_name, p.color as project_color,
               creator.name as creator_name,
               assignee.name as assignee_name
        FROM tasks t
        JOIN projects p ON t.project_id = p.id
        JOIN users creator ON t.creator_id = creator.id
        LEFT JOIN users assignee ON t.assignee_id = assignee.id
        WHERE t.id = ?
    `, [taskId]);

    res.json(updatedTask);
});

// Delete task
app.delete('/api/tasks/:id', authenticate, (req, res) => {
    const taskId = req.params.id;

    // Check if user has access
    const task = dbGet(`
        SELECT t.* FROM tasks t
        JOIN project_members pm ON t.project_id = pm.project_id
        WHERE t.id = ? AND pm.user_id = ?
    `, [taskId, req.user.id]);

    if (!task) {
        return res.status(404).json({ error: 'Task not found or access denied' });
    }

    dbRun('DELETE FROM tasks WHERE id = ?', [taskId]);

    res.json({ message: 'Task deleted successfully' });
});

// ============== STATS ROUTE ==============

app.get('/api/stats', authenticate, (req, res) => {
    const result = dbGet(`
        SELECT
            COUNT(*) as total,
            SUM(CASE WHEN t.status = 'todo' THEN 1 ELSE 0 END) as todo,
            SUM(CASE WHEN t.status = 'progress' THEN 1 ELSE 0 END) as progress,
            SUM(CASE WHEN t.status = 'done' THEN 1 ELSE 0 END) as done
        FROM tasks t
        JOIN project_members pm ON t.project_id = pm.project_id
        WHERE pm.user_id = ?
    `, [req.user.id]);

    res.json(result || { total: 0, todo: 0, progress: 0, done: 0 });
});

// ============== SEARCH USERS ==============

app.get('/api/users/search', authenticate, (req, res) => {
    const { q } = req.query;

    if (!q || q.length < 2) {
        return res.json([]);
    }

    const users = dbAll(`
        SELECT id, name, email FROM users
        WHERE (name LIKE ? OR email LIKE ?) AND id != ?
        LIMIT 10
    `, [`%${q}%`, `%${q}%`, req.user.id]);

    res.json(users);
});

// Serve frontend
app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Start server
async function start() {
    await initDatabase();

    app.listen(PORT, () => {
        console.log(`
╔═══════════════════════════════════════════════════════════╗
║                                                           ║
║   🎨 Creatives Tracker Server                             ║
║                                                           ║
║   Server running at: http://localhost:${PORT}               ║
║                                                           ║
║   Features:                                               ║
║   • User authentication (signup/login)                    ║
║   • Project management with sharing                       ║
║   • Task creation, editing, filtering                     ║
║   • Real-time collaboration                               ║
║                                                           ║
║   Share projects by inviting team members by email!       ║
║                                                           ║
╚═══════════════════════════════════════════════════════════╝
        `);
    });
}

start().catch(console.error);
