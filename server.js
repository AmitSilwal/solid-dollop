const express = require('express');
const http = require('http');
const path = require('path');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'replace-with-a-secure-secret';

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// In-memory data stores (replace with a database in production)
const users = new Map(); // username -> { id, username, passwordHash }
const activeSocketsByUserId = new Map(); // userId -> socket.id
const messages = []; // { id, fromUserId, toUserId, text, timestamp }
let nextUserId = 1;
let nextMessageId = 1;

function publicUser(user) {
  return { id: user.id, username: user.username };
}

function requireAuth(req, res, next) {
  const auth = req.headers.authorization;
  if (!auth || !auth.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Missing or invalid authorization header.' });
  }

  const token = auth.slice('Bearer '.length);

  try {
    const payload = jwt.verify(token, JWT_SECRET);
    req.user = payload;
    return next();
  } catch (error) {
    return res.status(401).json({ error: 'Invalid or expired token.' });
  }
}

app.post('/api/register', async (req, res) => {
  const { username, password } = req.body;

  if (!username || !password) {
    return res.status(400).json({ error: 'Username and password are required.' });
  }

  if (users.has(username)) {
    return res.status(409).json({ error: 'Username already exists.' });
  }

  const passwordHash = await bcrypt.hash(password, 10);
  const user = { id: String(nextUserId++), username, passwordHash };
  users.set(username, user);

  const token = jwt.sign({ userId: user.id, username: user.username }, JWT_SECRET, {
    expiresIn: '24h'
  });

  return res.status(201).json({ token, user: publicUser(user) });
});

app.post('/api/login', async (req, res) => {
  const { username, password } = req.body;

  if (!username || !password) {
    return res.status(400).json({ error: 'Username and password are required.' });
  }

  const user = users.get(username);
  if (!user) {
    return res.status(401).json({ error: 'Invalid credentials.' });
  }

  const valid = await bcrypt.compare(password, user.passwordHash);
  if (!valid) {
    return res.status(401).json({ error: 'Invalid credentials.' });
  }

  const token = jwt.sign({ userId: user.id, username: user.username }, JWT_SECRET, {
    expiresIn: '24h'
  });

  return res.json({ token, user: publicUser(user) });
});

app.get('/api/users', requireAuth, (req, res) => {
  const currentUserId = req.user.userId;

  const availableUsers = Array.from(users.values())
    .filter((u) => u.id !== currentUserId)
    .map((u) => ({ ...publicUser(u), online: activeSocketsByUserId.has(u.id) }));

  return res.json({ users: availableUsers });
});

app.get('/api/messages/:otherUserId', requireAuth, (req, res) => {
  const { otherUserId } = req.params;
  const currentUserId = req.user.userId;

  const conversation = messages.filter(
    (m) =>
      (m.fromUserId === currentUserId && m.toUserId === otherUserId) ||
      (m.fromUserId === otherUserId && m.toUserId === currentUserId)
  );

  return res.json({ messages: conversation });
});

io.use((socket, next) => {
  const token = socket.handshake.auth?.token;
  if (!token) {
    return next(new Error('Missing auth token'));
  }

  try {
    const payload = jwt.verify(token, JWT_SECRET);
    socket.user = payload;
    return next();
  } catch (error) {
    return next(new Error('Invalid auth token'));
  }
});

io.on('connection', (socket) => {
  const { userId } = socket.user;
  activeSocketsByUserId.set(userId, socket.id);

  io.emit('presence:update', Array.from(activeSocketsByUserId.keys()));

  socket.on('message:send', ({ toUserId, text }) => {
    if (!toUserId || !text || !text.trim()) {
      return;
    }

    const message = {
      id: String(nextMessageId++),
      fromUserId: userId,
      toUserId,
      text: text.trim(),
      timestamp: new Date().toISOString()
    };

    messages.push(message);

    socket.emit('message:new', message);
    const recipientSocketId = activeSocketsByUserId.get(toUserId);
    if (recipientSocketId) {
      io.to(recipientSocketId).emit('message:new', message);
    }
  });

  socket.on('disconnect', () => {
    activeSocketsByUserId.delete(userId);
    io.emit('presence:update', Array.from(activeSocketsByUserId.keys()));
  });
});

server.listen(PORT, () => {
  console.log(`Chat app listening at http://localhost:${PORT}`);
});
