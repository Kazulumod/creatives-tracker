const express = require('express');
const { Pool } = require('pg');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const cors = require('cors');
const path = require('path');
const nodemailer = require('nodemailer');

const app = express();
const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'creatives-tracker-secret-key-change-in-production';
const INVITE_CODE = process.env.INVITE_CODE || 'CREATIVES2026';

// Email Configuration
const EMAIL_USER = process.env.EMAIL_USER;
const EMAIL_PASS = process.env.EMAIL_PASS;
const EMAIL_FROM = process.env.EMAIL_FROM || 'Creatives Tracker <noreply@creativestracker.com>';

let transporter = null;
if (EMAIL_USER && EMAIL_PASS) {
    transporter = nodemailer.createTransport({
        service: 'gmail',
        auth: { user: EMAIL_USER, pass: EMAIL_PASS }
    });
    console.log(`Email configured: ${EMAIL_USER}`);
} else {
    console.warn('Email not configured — set EMAIL_USER and EMAIL_PASS in environment variables to enable notifications');
}

// ── Shared email layout ─────────────────────────────────────
function emailLayout(bodyHtml) {
    return `
        <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;background:#ffffff;">
            <div style="background:#84cc16;padding:18px 24px;border-radius:8px 8px 0 0;">
                <h1 style="color:#09090b;margin:0;font-size:20px;letter-spacing:-0.3px;">Creatives Tracker</h1>
            </div>
            <div style="padding:28px 32px;background:#f9fafb;border:1px solid #e5e7eb;border-top:none;">
                ${bodyHtml}
                <div style="margin-top:24px;">
                    <a href="https://creatives-tracker.onrender.com"
                       style="display:inline-block;background:#84cc16;color:#09090b;padding:10px 22px;
                              text-decoration:none;border-radius:6px;font-weight:700;font-size:14px;">
                        Open Creatives Tracker
                    </a>
                </div>
            </div>
            <div style="padding:14px;text-align:center;color:#9ca3af;font-size:12px;">
                Creatives Tracker · You're receiving this because you're involved in this task.
            </div>
        </div>`;
}

function taskCard(taskKey, taskSummary) {
    return `<div style="background:#fff;border-left:4px solid #84cc16;padding:16px 20px;
                         border-radius:4px;margin:16px 0;border:1px solid #e5e7eb;">
                <p style="margin:0 0 4px;color:#6b7280;font-size:11px;text-transform:uppercase;
                           letter-spacing:0.5px;">${taskKey}</p>
                <p style="margin:0;color:#111827;font-size:16px;font-weight:600;">${taskSummary}</p>
            </div>`;
}

async function sendAssignmentEmail(assigneeEmail, assigneeName, taskSummary, taskKey, assignerName) {
    if (!transporter) return;
    try {
        await transporter.sendMail({
            from: EMAIL_FROM,
            to: assigneeEmail,
            subject: `[${taskKey}] You've been assigned: ${taskSummary}`,
            html: emailLayout(`
                <p style="color:#374151;font-size:16px;margin:0 0 4px;">Hi <strong>${assigneeName}</strong>,</p>
                <p style="color:#6b7280;margin:4px 0 0;">
                    <strong>${assignerName}</strong> assigned you a task:
                </p>
                ${taskCard(taskKey, taskSummary)}
            `)
        });
        console.log(`Assignment email → ${assigneeEmail}`);
    } catch (err) { console.error('Assignment email failed:', err.message); }
}

async function sendMentionEmail(toEmail, toName, mentionedByName, taskSummary, taskKey, commentText) {
    if (!transporter) return;
    const preview = commentText.length > 200 ? commentText.slice(0, 200) + '…' : commentText;
    try {
        await transporter.sendMail({
            from: EMAIL_FROM,
            to: toEmail,
            subject: `[${taskKey}] ${mentionedByName} mentioned you`,
            html: emailLayout(`
                <p style="color:#374151;font-size:16px;margin:0 0 4px;">Hi <strong>${toName}</strong>,</p>
                <p style="color:#6b7280;margin:4px 0 16px;">
                    <strong>${mentionedByName}</strong> mentioned you in a comment on:
                </p>
                ${taskCard(taskKey, taskSummary)}
                <div style="background:#fff;border:1px solid #e5e7eb;border-radius:6px;padding:14px 18px;
                             color:#374151;font-size:14px;line-height:1.6;white-space:pre-wrap;">
                    ${preview.replace(/</g,'&lt;').replace(/>/g,'&gt;')}
                </div>
            `)
        });
        console.log(`Mention email → ${toEmail}`);
    } catch (err) { console.error('Mention email failed:', err.message); }
}

async function sendTaskUpdateEmail(toEmail, toName, changerName, taskSummary, taskKey, changes) {
    if (!transporter || !changes.length) return;
    const changeRows = changes
        .map(c => `<tr><td style="padding:6px 0;color:#6b7280;font-size:13px;width:110px;
                        vertical-align:top;">${c.label}</td>
                       <td style="padding:6px 0;color:#111827;font-size:13px;">${c.value}</td></tr>`)
        .join('');
    try {
        await transporter.sendMail({
            from: EMAIL_FROM,
            to: toEmail,
            subject: `[${taskKey}] Task updated: ${taskSummary}`,
            html: emailLayout(`
                <p style="color:#374151;font-size:16px;margin:0 0 4px;">Hi <strong>${toName}</strong>,</p>
                <p style="color:#6b7280;margin:4px 0 16px;">
                    <strong>${changerName}</strong> updated a task you're involved in:
                </p>
                ${taskCard(taskKey, taskSummary)}
                <table style="width:100%;border-collapse:collapse;margin-top:4px;">${changeRows}</table>
            `)
        });
        console.log(`Update email → ${toEmail}`);
    } catch (err) { console.error('Task update email failed:', err.message); }
}

function detectTaskChanges(old, body) {
    const statusLabels = { todo: 'To Do', progress: 'In Progress', review: 'For Review', done: 'Done' };
    const changes = [];
    if (body.status && body.status !== old.status)
        changes.push({ label: 'Status', value: `${statusLabels[old.status] || old.status} → ${statusLabels[body.status] || body.status}` });
    if (body.priority && body.priority !== old.priority)
        changes.push({ label: 'Priority', value: `${old.priority} → ${body.priority}` });
    if (body.due_date !== undefined && body.due_date !== old.due_date)
        changes.push({ label: 'Due Date', value: body.due_date || 'Removed' });
    if (body.summary && body.summary !== old.summary)
        changes.push({ label: 'Title', value: body.summary });
    if (body.assignee_id !== undefined && String(body.assignee_id) !== String(old.assignee_id))
        changes.push({ label: 'Assignee', value: 'Changed' });
    if (body.ministry && body.ministry !== old.ministry)
        changes.push({ label: 'Ministry', value: body.ministry });
    return changes;
}

// PostgreSQL Connection
const pool = new Pool({
    connectionString: process.env.DATABASE_URL || 'postgresql://neondb_owner:npg_Qi2Ms6uklISB@ep-plain-moon-a1ot90sj8-pooler.ap-southeast-1.aws.neon.tech/neondb?sslmode=require',
    ssl: { rejectUnauthorized: false }
});

// Middleware
app.use(cors());
app.use(express.json({ limit: '100mb' }));
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
                ministry TEXT DEFAULT 'General',
                project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
                assignee_id INTEGER REFERENCES users(id),
                creator_id INTEGER NOT NULL REFERENCES users(id),
                due_date TEXT,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        `);

        // Add ministry column to tasks if it doesn't exist
        await client.query(`
            DO $$
            BEGIN
                IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='tasks' AND column_name='ministry') THEN
                    ALTER TABLE tasks ADD COLUMN ministry TEXT DEFAULT 'General';
                END IF;
            END $$;
        `);

        await client.query(`
            CREATE TABLE IF NOT EXISTS task_counter (
                project_id INTEGER PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
                counter INTEGER DEFAULT 0
            )
        `);

        await client.query(`
            DO $$
            BEGIN
                IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='users' AND column_name='is_admin') THEN
                    ALTER TABLE users ADD COLUMN is_admin BOOLEAN DEFAULT FALSE;
                END IF;
            END $$;
        `);

        await client.query(`UPDATE users SET is_admin = TRUE WHERE email IN ('audrey.john@pray.com', 'kazulumod@gmail.com')`);

        await client.query(`
            CREATE TABLE IF NOT EXISTS comments (
                id SERIAL PRIMARY KEY,
                task_id INTEGER REFERENCES tasks(id) ON DELETE CASCADE,
                user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
                content TEXT NOT NULL DEFAULT '',
                image_data TEXT,
                created_at TIMESTAMP DEFAULT NOW()
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

const isAdmin = async (req, res, next) => {
    try {
        const result = await pool.query('SELECT is_admin FROM users WHERE id = $1', [req.user.id]);
        if (!result.rows[0]?.is_admin) {
            return res.status(403).json({ error: 'Admin access required' });
        }
        req.user.is_admin = true;
        next();
    } catch (err) {
        res.status(500).json({ error: 'Server error' });
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
        const token = jwt.sign({ id: user.id, email: user.email, is_admin: user.is_admin }, JWT_SECRET, { expiresIn: '7d' });

        res.json({
            user: { id: user.id, name: user.name, email: user.email, is_admin: user.is_admin, created_at: user.created_at },
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
        const result = await pool.query('SELECT id, name, email, is_admin, created_at FROM users WHERE id = $1', [req.user.id]);
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

        const adminCheck = await pool.query('SELECT is_admin FROM users WHERE id = $1', [req.user.id]);
        const userIsAdmin = adminCheck.rows[0]?.is_admin;
        if (!userIsAdmin) {
            const projectCheck = await pool.query('SELECT * FROM projects WHERE id = $1 AND owner_id = $2',
                [projectId, req.user.id]);
            if (projectCheck.rows.length === 0) {
                return res.status(403).json({ error: 'Only project owners can delete projects' });
            }
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
        const { summary, description, status, priority, ministry, project_id, assignee_id, due_date } = req.body;

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
            INSERT INTO tasks (key, summary, description, status, priority, ministry, project_id, assignee_id, creator_id, due_date)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING id
        `, [
            taskKey,
            summary,
            description || '',
            status || 'todo',
            priority || 'medium',
            ministry || 'General',
            project_id,
            assignee_id || null,
            req.user.id,
            due_date || null
        ]);

        const taskId = taskResult.rows[0].id;
        const fullTaskResult = await pool.query(`
            SELECT t.*, p.name as project_name, p.color as project_color,
                   creator.name as creator_name,
                   assignee.name as assignee_name,
                   assignee.email as assignee_email
            FROM tasks t
            JOIN projects p ON t.project_id = p.id
            JOIN users creator ON t.creator_id = creator.id
            LEFT JOIN users assignee ON t.assignee_id = assignee.id
            WHERE t.id = $1
        `, [taskId]);

        const task = fullTaskResult.rows[0];

        // Send email notification if task is assigned
        if (assignee_id && task.assignee_email) {
            const creatorResult = await pool.query('SELECT name FROM users WHERE id = $1', [req.user.id]);
            const assignerName = creatorResult.rows[0]?.name || 'Someone';
            sendAssignmentEmail(task.assignee_email, task.assignee_name, summary, taskKey, assignerName);
        }

        res.status(201).json(task);
    } catch (err) {
        console.error('Create task error:', err);
        res.status(500).json({ error: 'Server error' });
    }
});

// Update task
app.put('/api/tasks/:id', authenticate, async (req, res) => {
    try {
        const taskId = req.params.id;
        const { summary, description, status, priority, ministry, assignee_id, due_date, project_id } = req.body;

        const taskCheck = await pool.query(`
            SELECT t.* FROM tasks t
            JOIN project_members pm ON t.project_id = pm.project_id
            WHERE t.id = $1 AND pm.user_id = $2
        `, [taskId, req.user.id]);

        if (taskCheck.rows.length === 0) {
            return res.status(404).json({ error: 'Task not found or access denied' });
        }

        const task = taskCheck.rows[0];

        let newProjectId = task.project_id;
        if (project_id && parseInt(project_id) !== task.project_id) {
            const newProjCheck = await pool.query(
                'SELECT 1 FROM project_members WHERE project_id = $1 AND user_id = $2',
                [project_id, req.user.id]
            );
            if (newProjCheck.rows.length === 0) {
                return res.status(403).json({ error: 'You are not a member of the target project' });
            }
            newProjectId = parseInt(project_id);
        }

        await pool.query(`
            UPDATE tasks SET
                summary = COALESCE($1, summary),
                description = COALESCE($2, description),
                status = COALESCE($3, status),
                priority = COALESCE($4, priority),
                ministry = COALESCE($5, ministry),
                assignee_id = $6,
                due_date = $7,
                project_id = $8,
                updated_at = CURRENT_TIMESTAMP
            WHERE id = $9
        `, [
            summary,
            description,
            status,
            priority,
            ministry,
            assignee_id !== undefined ? assignee_id : task.assignee_id,
            due_date !== undefined ? due_date : task.due_date,
            newProjectId,
            taskId
        ]);

        const updatedResult = await pool.query(`
            SELECT t.*, p.name as project_name, p.color as project_color,
                   creator.name as creator_name,
                   assignee.name as assignee_name,
                   assignee.email as assignee_email
            FROM tasks t
            JOIN projects p ON t.project_id = p.id
            JOIN users creator ON t.creator_id = creator.id
            LEFT JOIN users assignee ON t.assignee_id = assignee.id
            WHERE t.id = $1
        `, [taskId]);

        const updatedTask = updatedResult.rows[0];

        // Determine what changed and notify involved users
        const changes = detectTaskChanges(task, req.body);
        if (changes.length) {
            const changerResult = await pool.query('SELECT name FROM users WHERE id = $1', [req.user.id]);
            const changerName = changerResult.rows[0]?.name || 'Someone';

            // Collect involved users: creator + assignee (deduplicated, exclude the person making the change)
            const involvedIds = new Set();
            if (task.creator_id && task.creator_id !== req.user.id) involvedIds.add(task.creator_id);
            const newAssigneeId = assignee_id !== undefined ? assignee_id : task.assignee_id;
            if (newAssigneeId && newAssigneeId !== req.user.id) involvedIds.add(newAssigneeId);

            if (involvedIds.size) {
                const involvedResult = await pool.query(
                    'SELECT id, name, email FROM users WHERE id = ANY($1)',
                    [Array.from(involvedIds)]
                );
                const isNewAssignee = assignee_id && String(assignee_id) !== String(task.assignee_id);
                for (const u of involvedResult.rows) {
                    if (isNewAssignee && String(u.id) === String(assignee_id)) {
                        // New assignee gets an assignment email instead of a generic update
                        sendAssignmentEmail(u.email, u.name, updatedTask.summary, updatedTask.key, changerName);
                    } else {
                        sendTaskUpdateEmail(u.email, u.name, changerName, updatedTask.summary, updatedTask.key, changes);
                    }
                }
            }
        }

        res.json(updatedTask);
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
                SUM(CASE WHEN t.status = 'review' THEN 1 ELSE 0 END) as review,
                SUM(CASE WHEN t.status = 'done' THEN 1 ELSE 0 END) as done
            FROM tasks t
            JOIN project_members pm ON t.project_id = pm.project_id
            WHERE pm.user_id = $1
        `, [req.user.id]);

        res.json(result.rows[0] || { total: 0, todo: 0, progress: 0, review: 0, done: 0 });
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

// ============== ADMIN ROUTES ==============

app.get('/api/admin/users', authenticate, isAdmin, async (req, res) => {
    try {
        const result = await pool.query(`
            SELECT u.id, u.name, u.email, u.is_admin, u.created_at,
                   COUNT(DISTINCT pm.project_id) as project_count,
                   COUNT(DISTINCT t.id) as task_count
            FROM users u
            LEFT JOIN project_members pm ON u.id = pm.user_id
            LEFT JOIN tasks t ON u.id = t.creator_id
            GROUP BY u.id
            ORDER BY u.created_at ASC
        `);
        res.json(result.rows);
    } catch (err) {
        res.status(500).json({ error: 'Server error' });
    }
});

app.put('/api/admin/users/:id/toggle-admin', authenticate, isAdmin, async (req, res) => {
    try {
        const userId = parseInt(req.params.id);
        if (userId === req.user.id) {
            return res.status(400).json({ error: 'Cannot change your own admin status' });
        }
        const result = await pool.query(
            'UPDATE users SET is_admin = NOT is_admin WHERE id = $1 RETURNING id, name, email, is_admin',
            [userId]
        );
        res.json(result.rows[0]);
    } catch (err) {
        res.status(500).json({ error: 'Server error' });
    }
});

app.delete('/api/admin/users/:id', authenticate, isAdmin, async (req, res) => {
    try {
        const userId = parseInt(req.params.id);
        if (userId === req.user.id) {
            return res.status(400).json({ error: 'Cannot delete your own account' });
        }
        await pool.query('DELETE FROM users WHERE id = $1', [userId]);
        res.json({ message: 'User deleted successfully' });
    } catch (err) {
        res.status(500).json({ error: 'Server error' });
    }
});

app.get('/api/admin/projects', authenticate, isAdmin, async (req, res) => {
    try {
        const result = await pool.query(`
            SELECT p.id, p.name, p.color, p.ministry, p.created_at,
                   u.name as owner_name, u.email as owner_email,
                   COUNT(DISTINCT pm.user_id) as member_count,
                   COUNT(DISTINCT t.id) as task_count
            FROM projects p
            JOIN users u ON p.owner_id = u.id
            LEFT JOIN project_members pm ON p.id = pm.project_id
            LEFT JOIN tasks t ON p.id = t.project_id
            GROUP BY p.id, u.name, u.email
            ORDER BY p.created_at ASC
        `);
        res.json(result.rows);
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

// ============== COMMENT ROUTES ==============

app.get('/api/tasks/:id/comments', authenticate, async (req, res) => {
    try {
        const result = await pool.query(
            `SELECT c.*, u.name as user_name FROM comments c
             LEFT JOIN users u ON c.user_id = u.id
             WHERE c.task_id = $1 ORDER BY c.created_at ASC`,
            [req.params.id]
        );
        res.json(result.rows);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/tasks/:id/comments', authenticate, async (req, res) => {
    const { content, image_data } = req.body;
    if (!content && !image_data) return res.status(400).json({ error: 'Comment cannot be empty' });
    try {
        const result = await pool.query(
            `INSERT INTO comments (task_id, user_id, content, image_data)
             VALUES ($1, $2, $3, $4) RETURNING *`,
            [req.params.id, req.user.id, content || '', image_data || null]
        );
        const comment = result.rows[0];
        const commenterResult = await pool.query('SELECT name FROM users WHERE id = $1', [req.user.id]);
        comment.user_name = commenterResult.rows[0]?.name;
        const commenterName = comment.user_name || 'Someone';

        // Send @mention emails — check each user's name literally in the content
        if (content && content.includes('@')) {
            const taskResult = await pool.query('SELECT key, summary FROM tasks WHERE id = $1', [req.params.id]);
            const task = taskResult.rows[0];
            const allUsers = await pool.query('SELECT id, name, email FROM users WHERE id != $1', [req.user.id]);
            for (const u of allUsers.rows) {
                if (content.includes('@' + u.name)) {
                    console.log(`Mention detected: @${u.name} → ${u.email}`);
                    sendMentionEmail(u.email, u.name, commenterName, task.summary, task.key, content);
                }
            }
        }

        res.status(201).json(comment);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete('/api/comments/:id', authenticate, async (req, res) => {
    try {
        const result = await pool.query('SELECT user_id FROM comments WHERE id = $1', [req.params.id]);
        if (!result.rows[0]) return res.status(404).json({ error: 'Comment not found' });
        const adminCheck = await pool.query('SELECT is_admin FROM users WHERE id = $1', [req.user.id]);
        if (result.rows[0].user_id !== req.user.id && !adminCheck.rows[0]?.is_admin)
            return res.status(403).json({ error: 'Not authorized' });
        await pool.query('DELETE FROM comments WHERE id = $1', [req.params.id]);
        res.json({ message: 'Deleted' });
    } catch (err) { res.status(500).json({ error: err.message }); }
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
