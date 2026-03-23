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
const JWT_EXPIRY = '24h';

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// In-memory data stores (replace with a database in production)
const users = new Map(); // username -> { id, username, passwordHash, publicKey }
const activeSocketsByUserId = new Map(); // userId -> socket.id
const messages = []; // { id, fromUserId, toUserId, encryptedPayload, timestamp }
let nextUserId = 1;
let nextMessageId = 1;

function publicUser(user, includePublicKey = false) {
  return {
    id: user.id,
    username: user.username,
    ...(includePublicKey ? { publicKey: user.publicKey || null } : {})
  };
}

function findUserById(userId) {
  return Array.from(users.values()).find((user) => user.id === userId) || null;
}

function signToken(user) {
  return jwt.sign({ userId: user.id, username: user.username }, JWT_SECRET, {
    expiresIn: JWT_EXPIRY
  });
}

function parseBearerToken(header) {
  if (!header || !header.startsWith('Bearer ')) {
    return null;
  }

  return header.slice('Bearer '.length);
}

function verifyToken(token) {
  if (!token) {
    throw new Error('Missing token');
  }

  const payload = jwt.verify(token, JWT_SECRET);
  const user = findUserById(payload.userId);

  if (!user) {
    throw new Error('User no longer exists');
  }

  return { payload, user };
}

function requireApiAuth(req, res, next) {
  const token = parseBearerToken(req.headers.authorization);
  if (!token) {
    return res.status(401).json({ error: 'Missing or invalid authorization header.' });
  }

  try {
    const { payload, user } = verifyToken(token);
    req.user = payload;
    req.authUser = user;
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
  const user = { id: String(nextUserId++), username, passwordHash, publicKey: null };
  users.set(username, user);

  const token = signToken(user);

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

  const token = signToken(user);

  return res.json({ token, user: publicUser(user) });
});

app.put('/api/me/public-key', requireApiAuth, (req, res) => {
  const { publicKey } = req.body;

  if (!publicKey || typeof publicKey !== 'string') {
    return res.status(400).json({ error: 'A valid publicKey string is required.' });
  }

  req.authUser.publicKey = publicKey;
  return res.json({ user: publicUser(req.authUser, true) });
});

app.get('/api/users', requireApiAuth, (req, res) => {
  const currentUserId = req.user.userId;

  const availableUsers = Array.from(users.values())
    .filter((u) => u.id !== currentUserId)
    .map((u) => ({
      ...publicUser(u, true),
      online: activeSocketsByUserId.has(u.id),
      hasPublicKey: Boolean(u.publicKey)
    }));

  return res.json({ users: availableUsers });
});

app.get('/api/messages/:otherUserId', requireApiAuth, (req, res) => {
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
  const handshakeToken = socket.handshake.auth?.token;
  const headerToken = parseBearerToken(socket.handshake.headers.authorization);
  const token = handshakeToken || headerToken;
  if (!token) {
    return next(new Error('Missing auth token'));
  }

  try {
    const { payload, user } = verifyToken(token);
    socket.user = payload;
    socket.authUser = user;
    return next();
  } catch (error) {
    return next(new Error('Invalid auth token'));
  }
});

io.on('connection', (socket) => {
  const { userId } = socket.user;
  activeSocketsByUserId.set(userId, socket.id);

  io.emit('presence:update', Array.from(activeSocketsByUserId.keys()));

  socket.on('message:send', ({ toUserId, encryptedPayload }) => {
    if (!toUserId || !encryptedPayload || typeof encryptedPayload !== 'object') {
      return;
    }

    const {
      ciphertext,
      iv,
      senderEncryptedKey,
      recipientEncryptedKey,
      algorithm = 'AES-GCM+RSA-OAEP'
    } = encryptedPayload;

    if (!ciphertext || !iv || !senderEncryptedKey || !recipientEncryptedKey) {
      return;
    }

    const message = {
      id: String(nextMessageId++),
      fromUserId: userId,
      toUserId,
      encryptedPayload: {
        ciphertext,
        iv,
        senderEncryptedKey,
        recipientEncryptedKey,
        algorithm
      },
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
