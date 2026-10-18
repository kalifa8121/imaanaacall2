const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { Pool } = require('pg');
const path = require('path');
const bcrypt = require('bcryptjs');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { maxHttpBufferSize: 1e8 });

const PORT = process.env.PORT || 10000;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : false
});

app.use(express.json({ limit: '100mb' }));
app.use(express.static(path.join(__dirname, 'public')));

async function initDB() {
  try {
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

    await pool.query(`
      ALTER TABLE users ADD COLUMN IF NOT EXISTS is_admin BOOLEAN DEFAULT FALSE;
      ALTER TABLE users ADD COLUMN IF NOT EXISTS password TEXT;
      ALTER TABLE users ADD COLUMN IF NOT EXISTS phone VARCHAR(20);
      ALTER TABLE users ADD COLUMN IF NOT EXISTS bio TEXT;
      ALTER TABLE users ADD COLUMN IF NOT EXISTS avatar TEXT;
      ALTER TABLE users ADD COLUMN IF NOT EXISTS is_vip BOOLEAN DEFAULT FALSE;
      ALTER TABLE users ADD COLUMN IF NOT EXISTS banned_until TIMESTAMP DEFAULT NULL;
    `);

    console.log("Database initialized & schema updated.");
  } catch (err) {
    console.error("DB Error:", err);
  }
}
initDB();

// AUTH APIS
app.post('/api/auth/signup', async (req, res) => {
  const { username, password, phone, bio } = req.body;
  try {
    const hashedPassword = await bcrypt.hash(password, 10);
    const userRes = await pool.query(
      'INSERT INTO users (username, password, phone, bio) VALUES ($1, $2, $3, $4) RETURNING id, username, is_admin, is_vip',
      [username, hashedPassword, phone, bio]
    );
    res.json({ success: true, user: userRes.rows[0] });
  } catch (err) {
    res.status(400).json({ success: false, message: "Username'n kun dhihaateera!" });
  }
});

app.post('/api/auth/login', async (req, res) => {
  const { username, password } = req.body;
  try {
    const userRes = await pool.query('SELECT * FROM users WHERE username = $1', [username]);
    if (userRes.rows.length === 0) return res.status(400).json({ success: false, message: "Maqaan akkasii hin jiru!" });

    const user = userRes.rows[0];
    if (user.banned_until && new Date(user.banned_until) > new Date()) {
      return res.status(403).json({ success: false, message: `Account'n keessan hanga ${user.banned_until} patti ban ta'eera!` });
    }

    const validPass = await bcrypt.compare(password, user.password);
    if (!validPass) return res.status(400).json({ success: false, message: "Password dogoggora!" });

    delete user.password;
    res.json({ success: true, user });
  } catch (err) {
    res.status(500).json({ success: false, message: "Server Error" });
  }
});

app.post('/api/profile/update', async (req, res) => {
  const { username, phone, bio, avatar } = req.body;
  await pool.query('UPDATE users SET phone = $1, bio = $2, avatar = $3 WHERE username = $4', [phone, bio, avatar, username]);
  res.json({ success: true });
});

app.get('/api/posts', async (req, res) => {
  const posts = await pool.query('SELECT * FROM posts WHERE approved = TRUE ORDER BY id DESC LIMIT 50');
  res.json(posts.rows);
});

app.get('/api/comments/:postId', async (req, res) => {
  const comments = await pool.query('SELECT * FROM comments WHERE post_id = $1 ORDER BY id ASC', [req.params.postId]);
  res.json(comments.rows);
});

// WEBRTC & SOCKET REALTIME
const activeUsers = {};

io.on('connection', (socket) => {
  socket.on('register-user', (username) => {
    activeUsers[socket.id] = { id: socket.id, username };
    broadcastUserList();
  });

  async function broadcastUserList() {
    const allUsersRes = await pool.query('SELECT username, avatar, is_vip FROM users');
    const onlineUsernames = Object.values(activeUsers).map(u => u.username);

    const userList = allUsersRes.rows.map(u => ({
      username: u.username,
      avatar: u.avatar,
      is_vip: u.is_vip,
      isOnline: onlineUsernames.includes(u.username),
      socketId: Object.keys(activeUsers).find(key => activeUsers[key].username === u.username)
    }));

    io.emit('update-user-list', userList);
  }

  // WEBRTC CALLING ENGINE
  socket.on('call-user', (data) => {
    const targetSocket = Object.keys(activeUsers).find(k => activeUsers[k].username === data.userToCall);
    if (targetSocket) {
      io.to(targetSocket).emit('incoming-call', {
        signal: data.signalData,
        from: socket.id,
        callerName: data.callerName,
        isVideo: data.isVideo
      });
    } else {
      socket.emit('call-failed-offline');
    }
  });

  socket.on('accept-call', (data) => io.to(data.to).emit('call-accepted', data.signal));
  socket.on('reject-call', (data) => io.to(data.to).emit('call-rejected'));

  socket.on('create-post', async (data) => {
    const res = await pool.query(
      'INSERT INTO posts (username, content, media_url, media_type, approved) VALUES ($1, $2, $3, $4, FALSE) RETURNING *',
      [data.username, data.content, data.mediaUrl || null, data.mediaType || null]
    );
    socket.emit('post-submitted-silent', res.rows[0]);
  });

  socket.on('like-post', async (postId) => {
    await pool.query('UPDATE posts SET likes = likes + 1 WHERE id = $1', [postId]);
    io.emit('update-likes', postId);
  });

  socket.on('add-comment', async (data) => {
    const res = await pool.query('INSERT INTO comments (post_id, username, comment) VALUES ($1, $2, $3) RETURNING *',
      [data.postId, data.username, data.comment]);
    io.emit('new-comment', res.rows[0]);
  });

  socket.on('disconnect', () => {
    delete activeUsers[socket.id];
    broadcastUserList();
  });
});

server.listen(PORT, () => console.log(`Server running on port ${PORT}`));
