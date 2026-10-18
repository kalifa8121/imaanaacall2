
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { Pool } = require('pg');
const path = require('path');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');

const app = express();
const server = http.createServer(app);

const io = new Server(server, {
  maxHttpBufferSize: 100 * 1024 * 1024
});

const PORT = process.env.PORT || 10000;

if (!process.env.DATABASE_URL) {
  console.error('ERROR: Render Environment keessatti DATABASE_URL hin jiru.');
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL
    ? { rejectUnauthorized: false }
    : false
});

app.use(express.json({ limit: '100mb' }));
app.use(express.urlencoded({ extended: true, limit: '100mb' }));
app.use(express.static(path.join(__dirname, 'public')));

const activeUsers = Object.create(null);
const sessions = new Map();

const ADMIN_USERNAME = process.env.ADMIN_USERNAME || 'admin';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'Admin@12345';

function createToken() {
  return crypto.randomBytes(32).toString('hex');
}

function publicUser(user) {
  if (!user) return null;
  const result = { ...user };
  delete result.password;
  return result;
}

function getToken(req) {
  const header = req.headers.authorization || '';
  return header.startsWith('Bearer ')
    ? header.slice(7)
    : '';
}

function requireLogin(req, res, next) {
  const token = getToken(req);
  const username = sessions.get(token);

  if (!username) {
    return res.status(401).json({
      success: false,
      message: 'Maaloo jalqaba login godhi.'
    });
  }

  req.username = username;
  next();
}

async function requireAdmin(req, res, next) {
  try {
    const username = sessions.get(getToken(req));

    if (!username) {
      return res.status(401).json({
        success: false,
        message: 'Admin login godhi.'
      });
    }

    const result = await pool.query(
      'SELECT is_admin FROM users WHERE username = $1',
      [username]
    );

    if (!result.rows[0] || !result.rows[0].is_admin) {
      return res.status(403).json({
        success: false,
        message: 'Admin qofaaf.'
      });
    }

    req.username = username;
    next();
  } catch (err) {
    console.error('Admin authentication error:', err.message);
    res.status(500).json({
      success: false,
      message: 'Server error.'
    });
  }
}

async function initDB() {
  // Tables duraan jiran hin haqin.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      username VARCHAR(50) UNIQUE NOT NULL,
      password TEXT NOT NULL,
      phone VARCHAR(20),
      bio TEXT,
      avatar TEXT,
      is_admin BOOLEAN DEFAULT FALSE,
      is_vip BOOLEAN DEFAULT FALSE,
      banned_until TIMESTAMP DEFAULT NULL
    );

    CREATE TABLE IF NOT EXISTS posts (
      id SERIAL PRIMARY KEY,
      username VARCHAR(50),
      content TEXT,
      media_url TEXT,
      media_type VARCHAR(20),
      likes INT DEFAULT 0,
      approved BOOLEAN DEFAULT FALSE,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS comments (
      id SERIAL PRIMARY KEY,
      post_id INT,
      username VARCHAR(50),
      comment TEXT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS missed_calls (
      id SERIAL PRIMARY KEY,
      caller VARCHAR(50),
      receiver VARCHAR(50),
      call_type VARCHAR(20),
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
  `);

  // Migration: columns dhabaman qofa dabala.
  const migrations = [
    ['users', 'is_admin', 'BOOLEAN DEFAULT FALSE'],
    ['users', 'password', 'TEXT'],
    ['users', 'phone', 'VARCHAR(20)'],
    ['users', 'bio', 'TEXT'],
    ['users', 'avatar', 'TEXT'],
    ['users', 'is_vip', 'BOOLEAN DEFAULT FALSE'],
    ['users', 'banned_until', 'TIMESTAMP DEFAULT NULL'],
    ['posts', 'username', 'VARCHAR(50)'],
    ['posts', 'content', 'TEXT'],
    ['posts', 'media_url', 'TEXT'],
    ['posts', 'media_type', 'VARCHAR(20)'],
    ['posts', 'likes', 'INT DEFAULT 0'],
    ['posts', 'approved', 'BOOLEAN DEFAULT FALSE'],
    ['posts', 'rejected', 'BOOLEAN DEFAULT FALSE'],
    ['posts', 'created_at', 'TIMESTAMP DEFAULT CURRENT_TIMESTAMP'],
    ['comments', 'post_id', 'INT'],
    ['comments', 'username', 'VARCHAR(50)'],
    ['comments', 'comment', 'TEXT'],
    ['comments', 'created_at', 'TIMESTAMP DEFAULT CURRENT_TIMESTAMP'],
    ['missed_calls', 'caller', 'VARCHAR(50)'],
    ['missed_calls', 'receiver', 'VARCHAR(50)'],
    ['missed_calls', 'call_type', 'VARCHAR(20)'],
    ['missed_calls', 'created_at', 'TIMESTAMP DEFAULT CURRENT_TIMESTAMP']
  ];

  for (const [table, column, type] of migrations) {
    await pool.query(
      `ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS ${column} ${type}`
    );
  }

  // Admin duraan jira yoo ta'e password isaa hin jijjiiru.
  const admin = await pool.query(
    'SELECT id FROM users WHERE username = $1',
    [ADMIN_USERNAME]
  );

  if (admin.rows.length === 0) {
    const hash = await bcrypt.hash(ADMIN_PASSWORD, 12);

    await pool.query(
      `INSERT INTO users (username, password, is_admin)
       VALUES ($1, $2, TRUE)`,
      [ADMIN_USERNAME, hash]
    );

    console.log('Initial admin account created.');
  }

  console.log('Database initialized & schema updated.');
}

// AUTH: SIGNUP
app.post('/api/auth/signup', async (req, res) => {
  try {
    const username =
      typeof req.body.username === 'string'
        ? req.body.username.trim()
        : '';

    const password = req.body.password;
    const phone = req.body.phone || '';
    const bio = req.body.bio || '';

    if (!username || typeof password !== 'string' || !password) {
      return res.status(400).json({
        success: false,
        message: 'Username fi password guuti.'
      });
    }

    if (username.length < 3 || username.length > 50) {
      return res.status(400).json({
        success: false,
        message: 'Username qubee 3 hanga 50 qabaachuu qaba.'
      });
    }

    if (password.length < 4) {
      return res.status(400).json({
        success: false,
        message: 'Password qubee 4 yoo xiqqaate qabaachuu qaba.'
      });
    }

    const existing = await pool.query(
      'SELECT id FROM users WHERE LOWER(username) = LOWER($1)',
      [username]
    );

    if (existing.rows.length > 0) {
      return res.status(409).json({
        success: false,
        message: 'Username kanaan account duraan jira. Maqaa biraa filadhu.'
      });
    }

    const hashedPassword = await bcrypt.hash(password, 12);

    const userRes = await pool.query(
      `INSERT INTO users (username, password, phone, bio)
       VALUES ($1, $2, $3, $4)
       RETURNING id, username, phone, bio, avatar, is_admin, is_vip`,
      [username, hashedPassword, phone, bio]
    );

    const user = userRes.rows[0];
    const token = createToken();
    sessions.set(token, user.username);

    return res.status(201).json({
      success: true,
      token,
      user,
      message: 'Signup milkaaʼeera.'
    });
  } catch (err) {
    console.error('Signup error:', err);

    if (err.code === '23505') {
      return res.status(409).json({
        success: false,
        message: 'Username kanaan account duraan jira. Maqaa biraa filadhu.'
      });
    }

    return res.status(500).json({
      success: false,
      message: 'Signup hin milkoofne. Server log ilaali.'
    });
  }
});

// AUTH: LOGIN
app.post('/api/auth/login', async (req, res) => {
  try {
    const username =
      typeof req.body.username === 'string'
        ? req.body.username.trim()
        : '';

    const password = req.body.password;

    if (!username || typeof password !== 'string' || !password) {
      return res.status(400).json({
        success: false,
        message: 'Username fi password guuti.'
      });
    }

    const userRes = await pool.query(
      'SELECT * FROM users WHERE LOWER(username) = LOWER($1)',
      [username]
    );

    if (userRes.rows.length === 0) {
      return res.status(400).json({
        success: false,
        message: 'Maqaan akkasii hin jiru!'
      });
    }

    const user = userRes.rows[0];

    if (user.banned_until && new Date(user.banned_until) > new Date()) {
      return res.status(403).json({
        success: false,
        message: `Account'n keessan hanga ${user.banned_until} patti ban ta'eera!`
      });
    }

    const validPass = await bcrypt.compare(password, user.password);

    if (!validPass) {
      return res.status(400).json({
        success: false,
        message: 'Password dogoggora!'
      });
    }

    const token = createToken();
    sessions.set(token, user.username);

    return res.json({
      success: true,
      token,
      user: publicUser(user)
    });
  } catch (err) {
    console.error('Login error:', err);
    res.status(500).json({
      success: false,
      message: 'Login irratti dogoggorri uumame.'
    });
  }
});

// LOGOUT
app.post('/api/auth/logout', requireLogin, (req, res) => {
  sessions.delete(getToken(req));
  res.json({ success: true });
});

// PROFILE UPDATE
app.post('/api/profile/update', async (req, res) => {
  try {
    // Frontend duraanii username erga; token yoo jiraates ni deeggarama.
    const tokenUsername = sessions.get(getToken(req));
    const username = tokenUsername || req.body.username;

    if (!username) {
      return res.status(401).json({
        success: false,
        message: 'Login godhi.'
      });
    }

    const { phone, bio, avatar } = req.body;

    const result = await pool.query(
      `UPDATE users
       SET phone = $1, bio = $2, avatar = $3
       WHERE username = $4
       RETURNING id, username, phone, bio, avatar, is_admin, is_vip`,
      [phone || '', bio || '', avatar || null, username]
    );

    if (!result.rows.length) {
      return res.status(404).json({
        success: false,
        message: 'User hin argamne.'
      });
    }

    res.json({ success: true, user: result.rows[0] });
  } catch (err) {
    console.error('Profile update error:', err);
    res.status(500).json({ success: false, message: 'Profile update hin milkoofne.' });
  }
});

// USER LIST
app.get('/api/users', async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT username, avatar, is_vip FROM users ORDER BY username'
    );

    const onlineNames = new Set(
      Object.values(activeUsers).map(u => u.username)
    );

    res.json(result.rows.map(u => ({
      ...u,
      isOnline: onlineNames.has(u.username),
      socketId: Object.keys(activeUsers).find(
        key => activeUsers[key].username === u.username
      ) || null
    })));
  } catch (err) {
    console.error('Users list error:', err);
    res.status(500).json({ success: false, message: 'User list hin argamne.' });
  }
});

// APPROVED POSTS ONLY
app.get('/api/posts', async (req, res) => {
  try {
    const posts = await pool.query(
      `SELECT * FROM posts
       WHERE approved = TRUE
       AND COALESCE(rejected, FALSE) = FALSE
       ORDER BY id DESC
       LIMIT 50`
    );

    res.json(posts.rows);
  } catch (err) {
    console.error('Posts error:', err);
    res.status(500).json({ success: false, message: 'Posts hin argamne.' });
  }
});

// COMMENTS
app.get('/api/comments/:postId', async (req, res) => {
  try {
    const comments = await pool.query(
      'SELECT * FROM comments WHERE post_id = $1 ORDER BY id ASC',
      [req.params.postId]
    );

    res.json(comments.rows);
  } catch (err) {
    console.error('Comments error:', err);
    res.status(500).json({ success: false, message: 'Comments hin argamne.' });
  }
});

// ADMIN: VIEW POSTS WAITING FOR APPROVAL
app.get('/api/admin/pending-posts', requireAdmin, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT * FROM posts
       WHERE approved = FALSE
       AND COALESCE(rejected, FALSE) = FALSE
       ORDER BY id ASC`
    );
    res.json(result.rows);
  } catch (err) {
    console.error('Pending posts error:', err);
    res.status(500).json({ success: false, message: 'Posts argachuu hin dandeenye.' });
  }
});

// ADMIN: APPROVE POST
app.post('/api/admin/approve-post', requireAdmin, async (req, res) => {
  try {
    const postId = Number(req.body.postId);

    if (!Number.isInteger(postId) || postId < 1) {
      return res.status(400).json({ success: false, message: 'Post ID dogoggora.' });
    }

    const result = await pool.query(
      `UPDATE posts
       SET approved = TRUE, rejected = FALSE
       WHERE id = $1
       RETURNING id`,
      [postId]
    );

    if (!result.rows.length) {
      return res.status(404).json({ success: false, message: 'Post hin argamne.' });
    }

    res.json({ success: true });
  } catch (err) {
    console.error('Approve post error:', err);
    res.status(500).json({ success: false, message: 'Post approve hin milkoofne.' });
  }
});

// ADMIN: REJECT POST
app.post('/api/admin/reject-post', requireAdmin, async (req, res) => {
  try {
    const postId = Number(req.body.postId);

    await pool.query(
      `UPDATE posts
       SET approved = FALSE, rejected = TRUE
       WHERE id = $1`,
      [postId]
    );

    res.json({ success: true });
  } catch (err) {
    console.error('Reject post error:', err);
    res.status(500).json({ success: false, message: 'Post reject hin milkoofne.' });
  }
});

// MISSED CALLS
app.get('/api/missed-calls', requireLogin, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT * FROM missed_calls
       WHERE receiver = $1
       ORDER BY id DESC
       LIMIT 50`,
      [req.username]
    );
    res.json(result.rows);
  } catch (err) {
    console.error('Missed calls error:', err);
    res.status(500).json({ success: false, message: 'Missed calls hin argamne.' });
  }
});

// SOCKET.IO / WEBRTC
io.on('connection', socket => {
  socket.on('register-user', async usernameValue => {
    try {
      const username = String(usernameValue || '').trim();
      if (!username) return;

      activeUsers[socket.id] = {
        id: socket.id,
        username
      };

      await broadcastUserList();
    } catch (err) {
      console.error('Register user error:', err);
    }
  });

  async function broadcastUserList() {
    try {
      const allUsersRes = await pool.query(
        'SELECT username, avatar, is_vip FROM users'
      );

      const onlineUsernames = new Set(
        Object.values(activeUsers).map(u => u.username)
      );

      const userList = allUsersRes.rows.map(u => ({
        username: u.username,
        avatar: u.avatar,
        is_vip: u.is_vip,
        isOnline: onlineUsernames.has(u.username),
        socketId: Object.keys(activeUsers).find(
          key => activeUsers[key].username === u.username
        ) || null
      }));

      io.emit('update-user-list', userList);
    } catch (err) {
      console.error('Broadcast user list error:', err);
    }
  }

  // VOICE / VIDEO CALL SIGNALING
  socket.on('call-user', async data => {
    try {
      const targetUsername = String(data?.userToCall || '');

      const targetSocket = Object.keys(activeUsers).find(
        key => activeUsers[key].username === targetUsername
      );

      if (targetSocket) {
        io.to(targetSocket).emit('incoming-call', {
          signal: data.signalData,
          from: socket.id,
          callerName: data.callerName,
          isVideo: Boolean(data.isVideo)
        });
      } else {
        if (data?.callerName && targetUsername) {
          await pool.query(
            `INSERT INTO missed_calls (caller, receiver, call_type)
             VALUES ($1, $2, $3)`,
            [
              data.callerName,
              targetUsername,
              data.isVideo ? 'video' : 'voice'
            ]
          );
        }

        socket.emit('call-failed-offline');
      }
    } catch (err) {
      console.error('Call error:', err);
      socket.emit('call-failed');
    }
  });

  socket.on('accept-call', data => {
    if (data?.to) {
      io.to(data.to).emit('call-accepted', data.signal);
    }
  });

  socket.on('reject-call', data => {
    if (data?.to) {
      io.to(data.to).emit('call-rejected');
    }
  });

  // POST SUBMISSION: USER ONLY SEES "posted"
  socket.on('create-post', async data => {
    try {
      const username = String(data?.username || '').trim();

      if (!username) {
        return socket.emit('post-submit-error', {
          message: 'Login godhi.'
        });
      }

      const result = await pool.query(
        `INSERT INTO posts
         (username, content, media_url, media_type, approved, rejected)
         VALUES ($1, $2, $3, $4, FALSE, FALSE)
         RETURNING id`,
        [
          username,
          data.content || '',
          data.mediaUrl || null,
          data.mediaType || null
        ]
      );

      // Review status user client'atti hin erginu.
      socket.emit('post-submitted-silent', {
        id: result.rows[0].id,
        message: 'posted'
      });
    } catch (err) {
      console.error('Create post error:', err);
      socket.emit('post-submit-error', {
        message: 'Post hin milkoofne. Irra deebi’i.'
      });
    }
  });

  socket.on('like-post', async postId => {
    try {
      await pool.query(
        `UPDATE posts
         SET likes = likes + 1
         WHERE id = $1 AND approved = TRUE`,
        [postId]
      );
      io.emit('update-likes', postId);
    } catch (err) {
      console.error('Like post error:', err);
    }
  });

  socket.on('add-comment', async data => {
    try {
      const result = await pool.query(
        `INSERT INTO comments (post_id, username, comment)
         SELECT $1, $2, $3
         WHERE EXISTS (
           SELECT 1 FROM posts
           WHERE id = $1 AND approved = TRUE
             AND COALESCE(rejected, FALSE) = FALSE
         )
         RETURNING *`,
        [data.postId, data.username, data.comment]
      );

      if (result.rows.length) {
        io.emit('new-comment', result.rows[0]);
      }
    } catch (err) {
      console.error('Add comment error:', err);
    }
  });

  socket.on('disconnect', async () => {
    delete activeUsers[socket.id];
    await broadcastUserList();
  });
});

// Express 5-compatible frontend fallback.
// API routes olitti waan hin tuqu.
app.get(/^(?!\/api(?:\/|$)).*/, (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Start only after DB setup succeeds.
async function startServer() {
  try {
    if (!process.env.DATABASE_URL) {
      throw new Error('DATABASE_URL Render Environment keessatti hin jiru.');
    }

    await initDB();

    server.listen(PORT, '0.0.0.0', () => {
      console.log(`Server running on port ${PORT}`);
    });
  } catch (err) {
    console.error('STARTUP ERROR:', err);
    process.exit(1);
  }
}

startServer();
