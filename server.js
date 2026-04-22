const express = require('express');
const { Pool } = require('pg');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const cors = require('cors');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'creatives-tracker-secret-key-change-in-production';
const INVITE_CODE = process.env.INVITE_CODE || 'CREATIVES2026';

// PostgreSQL Connection
const pool = new Pool({
    connectionString: process.env.DATABASE_URL || 'postgresql://neondb_owner:npg_Qi2Ms6uklISB@ep-plain-moon-a1ot90sj8-pooler.ap-southeast-1.aws.neon.tech/neondb?sslmode=require',
    ssl: { rejectUnauthorized: false }
});

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Initialize Database
async function initDatabase() {
    const client = await pool.connect();
    try {
        await client.query(`
            CREATE TABLE IF NOT EXISTS users (
                id SERIAL PRIMARY KEY,
                name TEXT NOT NULL,
                email TEXT UNIQUE NOT NULL,
                password TEXT NOT NULL,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        `);

        await client.query(`
            CREATE TABLE IF NOT EXISTS projects (
                id SERIAL PRIMARY KEY,
                name TEXT NOT NULL,
                color TEXT DEFAULT '#6366f1',
                ministry TEXT DEFAULT 'General',
                owner_id INTEGER NOT NULL REFERENCES users(id),
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        `);

        // Add ministry column if it doesn't exist (for existing databases)
        await client.query(`
            DO $$
            BEGIN
                IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='projects' AND column_name='ministry') THEN
                    ALTER TABLE projects ADD COLUMN ministry TEXT DEFAULT 'General';
                END IF;
            END $$;
        `);

        await client.query(`
            CREATE TABLE IF NOT EXISTS project_members (
                id SERIAL PRIMARY KEY,
                project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
                user_id INTEGER NOT NULL REFERENCES users(id),
                role TEXT DEFAULT 'member',
                invited_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                UNIQUE(project_id, user_id)
            )
        `);

        await client.query(`
            CREATE TABLE IF NOT EXISTS tasks (
                id SERIAL PRIMARY KEY,
                key TEXT NOT NULL,
                summary TEXT NOT NULL,
                description TEXT DEFAULT '',
                status TEXT DEFAULT 'todo',
                priority TEXT DEFAULT 'medium',
                project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
                assignee_id INTEGER REFERENCES users(id),
                creator_id INTEGER NOT NULL REFERENCES users(id),
                due_date TEXT,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        `);

        await client.query(`
            CREATE TABLE IF NOT EXISTS task_counter (
                project_id INTEGER PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
                counter INTEGER DEFAULT 0
            )
        `);

        console.log('Database initialized');
    } finally {
        client.release();
    }
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
        const existing = await pool.query('SELECT id FROM users WHERE email = $1', [email.toLowerCase()]);
        if (existing.rows.length > 0) {
            return res.status(400).json({ error: 'An account with this email already exists' });
        }

        // Hash password
        const hashedPassword = await bcrypt.hash(password, 10);

        // Create user
        const userResult = await pool.query(
            'INSERT INTO users (name, email, password) VALUES ($1, $2, $3) RETURNING id, name, email, created_at',
            [name, email.toLowerCase(), hashedPassword]
        );
        const user = userResult.rows[0];

        // Create default projects for the user
        const defaultProjects = [
            { name: 'Personal', color: '#8b5cf6' },
            { name: 'Work', color: '#10b981' },
            { name: 'Ideas', color: '#f59e0b' }
        ];

        for (const project of defaultProjects) {
            const projResult = await pool.query(
                'INSERT INTO projects (name, color, owner_id) VALUES ($1, $2, $3) RETURNING id',
                [project.name, project.color, user.id]
            );
            const projId = projResult.rows[0].id;
            await pool.query('INSERT INTO project_members (project_id, user_id, role) VALUES ($1, $2, $3)',
                [projId, user.id, 'owner']);
            await pool.query('INSERT INTO task_counter (project_id, counter) VALUES ($1, 0)', [projId]);
        }

        // Generate token
        const token = jwt.sign({ id: user.id, email: user.email }, JWT_SECRET, { expiresIn: '7d' });

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
        const result = await pool.query('SELECT * FROM users WHERE email = $1', [email.toLowerCase()]);
        const user = result.rows[0];
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

// Get current user
app.get('/api/auth/me', authenticate, async (req, res) => {
    try {
        const result = await pool.query('SELECT id, name, email, created_at FROM users WHERE id = $1', [req.user.id]);
        const user = result.rows[0];
        if (!user) {
            return res.status(404).json({ error: 'User not found' });
        }
        res.json(user);
    } catch (err) {
        res.status(500).json({ error: 'Server error' });
    }
});

// ============== PROJECT ROUTES ==============

// Get all projects for user
app.get('/api/projects', authenticate, async (req, res) => {
    try {
        const result = await pool.query(`
            SELECT p.*, pm.role,
                   (SELECT COUNT(*) FROM tasks WHERE project_id = p.id) as task_count,
                   u.name as owner_name
            FROM projects p
            JOIN project_members pm ON p.id = pm.project_id
            JOIN users u ON p.owner_id = u.id
            WHERE pm.user_id = $1
            ORDER BY p.created_at ASC
        `, [req.user.id]);
        res.json(result.rows);
    } catch (err) {
        res.status(500).json({ error: 'Server error' });
    }
});

// Create project
app.post('/api/projects', authenticate, async (req, res) => {
    try {
        const { name, color, ministry } = req.body;

        if (!name) {
            return res.status(400).json({ error: 'Project name is required' });
        }

        const projResult = await pool.query(
            'INSERT INTO projects (name, color, ministry, owner_id) VALUES ($1, $2, $3, $4) RETURNING *',
            [name, color || '#6366f1', ministry || 'General', req.user.id]
        );
        const project = projResult.rows[0];

        await pool.query('INSERT INTO project_members (project_id, user_id, role) VALUES ($1, $2, $3)',
            [project.id, req.user.id, 'owner']);
        await pool.query('INSERT INTO task_counter (project_id, counter) VALUES ($1, 0)', [project.id]);

        res.status(201).json(project);
    } catch (err) {
        res.status(500).json({ error: 'Server error' });
    }
});

// Get project members
app.get('/api/projects/:id/members', authenticate, async (req, res) => {
    try {
        const projectId = req.params.id;

        const memberCheck = await pool.query('SELECT * FROM project_members WHERE project_id = $1 AND user_id = $2',
            [projectId, req.user.id]);
        if (memberCheck.rows.length === 0) {
            return res.status(403).json({ error: 'Access denied' });
        }

        const result = await pool.query(`
            SELECT u.id, u.name, u.email, pm.role, pm.invited_at
            FROM project_members pm
            JOIN users u ON pm.user_id = u.id
            WHERE pm.project_id = $1
        `, [projectId]);

        res.json(result.rows);
    } catch (err) {
        res.status(500).json({ error: 'Server error' });
    }
});

// Invite member to project
app.post('/api/projects/:id/invite', authenticate, async (req, res) => {
    try {
        const projectId = req.params.id;
        const { email } = req.body;

        if (!email) {
            return res.status(400).json({ error: 'Email is required' });
        }

        const projectCheck = await pool.query('SELECT * FROM projects WHERE id = $1 AND owner_id = $2',
            [projectId, req.user.id]);
        if (projectCheck.rows.length === 0) {
            return res.status(403).json({ error: 'Only project owners can invite members' });
        }

        const userResult = await pool.query('SELECT id, name, email FROM users WHERE email = $1',
            [email.toLowerCase()]);
        if (userResult.rows.length === 0) {
            return res.status(404).json({ error: 'User not found. They need to sign up first.' });
        }
        const userToInvite = userResult.rows[0];

        const existingMember = await pool.query('SELECT * FROM project_members WHERE project_id = $1 AND user_id = $2',
            [projectId, userToInvite.id]);
        if (existingMember.rows.length > 0) {
            return res.status(400).json({ error: 'User is already a member of this project' });
        }

        await pool.query('INSERT INTO project_members (project_id, user_id, role) VALUES ($1, $2, $3)',
            [projectId, userToInvite.id, 'member']);

        res.json({ message: 'Member invited successfully', user: userToInvite });
    } catch (err) {
        res.status(500).json({ error: 'Server error' });
    }
});

// Remove member from project
app.delete('/api/projects/:id/members/:userId', authenticate, async (req, res) => {
    try {
        const projectId = req.params.id;
        const userIdToRemove = parseInt(req.params.userId);

        const projectCheck = await pool.query('SELECT * FROM projects WHERE id = $1 AND owner_id = $2',
            [projectId, req.user.id]);
        if (projectCheck.rows.length === 0) {
            return res.status(403).json({ error: 'Only project owners can remove members' });
        }

        if (userIdToRemove === req.user.id) {
            return res.status(400).json({ error: 'Cannot remove yourself as owner' });
        }

        await pool.query('DELETE FROM project_members WHERE project_id = $1 AND user_id = $2',
            [projectId, userIdToRemove]);

        res.json({ message: 'Member removed successfully' });
    } catch (err) {
        res.status(500).json({ error: 'Server error' });
    }
});

// Delete project
app.delete('/api/projects/:id', authenticate, async (req, res) => {
    try {
        const projectId = req.params.id;

        const projectCheck = await pool.query('SELECT * FROM projects WHERE id = $1 AND owner_id = $2',
            [projectId, req.user.id]);
        if (projectCheck.rows.length === 0) {
            return res.status(403).json({ error: 'Only project owners can delete projects' });
        }

        await pool.query('DELETE FROM tasks WHERE project_id = $1', [projectId]);
        await pool.query('DELETE FROM project_members WHERE project_id = $1', [projectId]);
        await pool.query('DELETE FROM task_counter WHERE project_id = $1', [projectId]);
        await pool.query('DELETE FROM projects WHERE id = $1', [projectId]);

        res.json({ message: 'Project deleted successfully' });
    } catch (err) {
        res.status(500).json({ error: 'Server error' });
    }
});

// ============== TASK ROUTES ==============

// Get all tasks for user
app.get('/api/tasks', authenticate, async (req, res) => {
    try {
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
            WHERE pm.user_id = $1
        `;

        const params = [req.user.id];
        let paramIndex = 2;

        if (project_id) {
            query += ` AND t.project_id = $${paramIndex}`;
            params.push(project_id);
            paramIndex++;
        }

        if (status && status !== 'all') {
            query += ` AND t.status = $${paramIndex}`;
            params.push(status);
            paramIndex++;
        }

        if (priority && priority !== 'all') {
            query += ` AND t.priority = $${paramIndex}`;
            params.push(priority);
            paramIndex++;
        }

        query += ' ORDER BY t.created_at DESC';

        const result = await pool.query(query, params);
        res.json(result.rows);
    } catch (err) {
        res.status(500).json({ error: 'Server error' });
    }
});

// Create task
app.post('/api/tasks', authenticate, async (req, res) => {
    try {
        const { summary, description, status, priority, project_id, assignee_id, due_date } = req.body;

        if (!summary || !project_id) {
            return res.status(400).json({ error: 'Summary and project are required' });
        }

        const memberCheck = await pool.query('SELECT * FROM project_members WHERE project_id = $1 AND user_id = $2',
            [project_id, req.user.id]);
        if (memberCheck.rows.length === 0) {
            return res.status(403).json({ error: 'Access denied to this project' });
        }

        // Get and increment task counter
        const counterResult = await pool.query('SELECT counter FROM task_counter WHERE project_id = $1', [project_id]);
        const newCounter = (counterResult.rows[0]?.counter || 0) + 1;
        await pool.query('UPDATE task_counter SET counter = $1 WHERE project_id = $2', [newCounter, project_id]);

        // Get project prefix
        const projectResult = await pool.query('SELECT name FROM projects WHERE id = $1', [project_id]);
        const prefix = projectResult.rows[0].name.substring(0, 3).toUpperCase();
        const taskKey = `${prefix}-${newCounter}`;

        const taskResult = await pool.query(`
            INSERT INTO tasks (key, summary, description, status, priority, project_id, assignee_id, creator_id, due_date)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id
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

        const taskId = taskResult.rows[0].id;
        const fullTaskResult = await pool.query(`
            SELECT t.*, p.name as project_name, p.color as project_color,
                   creator.name as creator_name,
                   assignee.name as assignee_name
            FROM tasks t
            JOIN projects p ON t.project_id = p.id
            JOIN users creator ON t.creator_id = creator.id
            LEFT JOIN users assignee ON t.assignee_id = assignee.id
            WHERE t.id = $1
        `, [taskId]);

        res.status(201).json(fullTaskResult.rows[0]);
    } catch (err) {
        console.error('Create task error:', err);
        res.status(500).json({ error: 'Server error' });
    }
});

// Update task
app.put('/api/tasks/:id', authenticate, async (req, res) => {
    try {
        const taskId = req.params.id;
        const { summary, description, status, priority, assignee_id, due_date } = req.body;

        const taskCheck = await pool.query(`
            SELECT t.* FROM tasks t
            JOIN project_members pm ON t.project_id = pm.project_id
            WHERE t.id = $1 AND pm.user_id = $2
        `, [taskId, req.user.id]);

        if (taskCheck.rows.length === 0) {
            return res.status(404).json({ error: 'Task not found or access denied' });
        }

        const task = taskCheck.rows[0];

        await pool.query(`
            UPDATE tasks SET
                summary = COALESCE($1, summary),
                description = COALESCE($2, description),
                status = COALESCE($3, status),
                priority = COALESCE($4, priority),
                assignee_id = $5,
                due_date = $6,
                updated_at = CURRENT_TIMESTAMP
            WHERE id = $7
        `, [
            summary,
            description,
            status,
            priority,
            assignee_id !== undefined ? assignee_id : task.assignee_id,
            due_date !== undefined ? due_date : task.due_date,
            taskId
        ]);

        const updatedResult = await pool.query(`
            SELECT t.*, p.name as project_name, p.color as project_color,
                   creator.name as creator_name,
                   assignee.name as assignee_name
            FROM tasks t
            JOIN projects p ON t.project_id = p.id
            JOIN users creator ON t.creator_id = creator.id
            LEFT JOIN users assignee ON t.assignee_id = assignee.id
            WHERE t.id = $1
        `, [taskId]);

        res.json(updatedResult.rows[0]);
    } catch (err) {
        res.status(500).json({ error: 'Server error' });
    }
});

// Delete task
app.delete('/api/tasks/:id', authenticate, async (req, res) => {
    try {
        const taskId = req.params.id;

        const taskCheck = await pool.query(`
            SELECT t.* FROM tasks t
            JOIN project_members pm ON t.project_id = pm.project_id
            WHERE t.id = $1 AND pm.user_id = $2
        `, [taskId, req.user.id]);

        if (taskCheck.rows.length === 0) {
            return res.status(404).json({ error: 'Task not found or access denied' });
        }

        await pool.query('DELETE FROM tasks WHERE id = $1', [taskId]);

        res.json({ message: 'Task deleted successfully' });
    } catch (err) {
        res.status(500).json({ error: 'Server error' });
    }
});

// ============== STATS ROUTE ==============

app.get('/api/stats', authenticate, async (req, res) => {
    try {
        const result = await pool.query(`
            SELECT
                COUNT(*) as total,
                SUM(CASE WHEN t.status = 'todo' THEN 1 ELSE 0 END) as todo,
                SUM(CASE WHEN t.status = 'progress' THEN 1 ELSE 0 END) as progress,
                SUM(CASE WHEN t.status = 'done' THEN 1 ELSE 0 END) as done
            FROM tasks t
            JOIN project_members pm ON t.project_id = pm.project_id
            WHERE pm.user_id = $1
        `, [req.user.id]);

        res.json(result.rows[0] || { total: 0, todo: 0, progress: 0, done: 0 });
    } catch (err) {
        res.status(500).json({ error: 'Server error' });
    }
});

// ============== ADMIN STATS ==============

app.get('/api/admin/stats', async (req, res) => {
    try {
        const adminKey = req.query.key;
        if (adminKey !== INVITE_CODE) {
            return res.status(403).json({ error: 'Access denied' });
        }

        const result = await pool.query('SELECT id, name, email, created_at FROM users ORDER BY created_at DESC');

        res.json({
            totalUsers: result.rows.length,
            users: result.rows
        });
    } catch (err) {
        res.status(500).json({ error: 'Server error' });
    }
});

// ============== SEARCH USERS ==============

app.get('/api/users/search', authenticate, async (req, res) => {
    try {
        const { q } = req.query;

        if (!q || q.length < 2) {
            return res.json([]);
        }

        const result = await pool.query(`
            SELECT id, name, email FROM users
            WHERE (name ILIKE $1 OR email ILIKE $1) AND id != $2
            LIMIT 10
        `, [`%${q}%`, req.user.id]);

        res.json(result.rows);
    } catch (err) {
        res.status(500).json({ error: 'Server error' });
    }
});

// Get all team members (for dropdowns)
app.get('/api/users/all', authenticate, async (req, res) => {
    try {
        const result = await pool.query('SELECT id, name, email FROM users ORDER BY name ASC');
        res.json(result.rows);
    } catch (err) {
        res.status(500).json({ error: 'Server error' });
    }
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
