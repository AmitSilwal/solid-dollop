const { useEffect, useMemo, useState } = React;

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();
const E2EE_STORAGE_PREFIX = 'chat-e2ee-keypair';

function toBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  for (let i = 0; i < bytes.byteLength; i += 1) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

function fromBase64(base64) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes.buffer;
}

async function exportPublicKey(key) {
  const spki = await crypto.subtle.exportKey('spki', key);
  return toBase64(spki);
}

async function importPublicKey(base64Key) {
  return crypto.subtle.importKey('spki', fromBase64(base64Key), { name: 'RSA-OAEP', hash: 'SHA-256' }, true, [
    'encrypt'
  ]);
}

async function generateKeyPair() {
  return crypto.subtle.generateKey(
    {
      name: 'RSA-OAEP',
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: 'SHA-256'
    },
    true,
    ['encrypt', 'decrypt']
  );
}

async function loadOrCreateKeyMaterial(userId) {
  const storageKey = `${E2EE_STORAGE_PREFIX}:${userId}`;
  const stored = localStorage.getItem(storageKey);

  if (stored) {
    const parsed = JSON.parse(stored);
    const privateKeyCrypto = await crypto.subtle.importKey(
      'pkcs8',
      fromBase64(parsed.privateKey),
      { name: 'RSA-OAEP', hash: 'SHA-256' },
      true,
      ['decrypt']
    );

    return {
      publicKeyBase64: parsed.publicKey,
      privateKeyCrypto
    };
  }

  const pair = await generateKeyPair();
  const publicKeyBase64 = await exportPublicKey(pair.publicKey);
  const privateKeyBase64 = toBase64(await crypto.subtle.exportKey('pkcs8', pair.privateKey));

  localStorage.setItem(
    storageKey,
    JSON.stringify({
      publicKey: publicKeyBase64,
      privateKey: privateKeyBase64
    })
  );

  return {
    publicKeyBase64,
    privateKeyCrypto: pair.privateKey
  };
}

async function encryptMessage(plainText, senderPublicKeyBase64, recipientPublicKeyBase64) {
  const symmetricKey = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt']);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, symmetricKey, textEncoder.encode(plainText));

  const exportedSymmetric = await crypto.subtle.exportKey('raw', symmetricKey);
  const senderPublicKey = await importPublicKey(senderPublicKeyBase64);
  const recipientPublicKey = await importPublicKey(recipientPublicKeyBase64);

  const senderEncryptedKey = await crypto.subtle.encrypt({ name: 'RSA-OAEP' }, senderPublicKey, exportedSymmetric);
  const recipientEncryptedKey = await crypto.subtle.encrypt({ name: 'RSA-OAEP' }, recipientPublicKey, exportedSymmetric);

  return {
    algorithm: 'AES-GCM+RSA-OAEP',
    ciphertext: toBase64(ciphertext),
    iv: toBase64(iv.buffer),
    senderEncryptedKey: toBase64(senderEncryptedKey),
    recipientEncryptedKey: toBase64(recipientEncryptedKey)
  };
}

async function decryptMessage(message, authUserId, privateKey) {
  if (!message?.encryptedPayload || !privateKey) {
    return '[Unable to decrypt]';
  }

  try {
    const isMine = message.fromUserId === authUserId;
    const encryptedKey = isMine
      ? message.encryptedPayload.senderEncryptedKey
      : message.encryptedPayload.recipientEncryptedKey;

    const symmetricRaw = await crypto.subtle.decrypt(
      { name: 'RSA-OAEP' },
      privateKey,
      fromBase64(encryptedKey)
    );

    const symmetricKey = await crypto.subtle.importKey('raw', symmetricRaw, { name: 'AES-GCM' }, false, ['decrypt']);

    const decrypted = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: new Uint8Array(fromBase64(message.encryptedPayload.iv)) },
      symmetricKey,
      fromBase64(message.encryptedPayload.ciphertext)
    );

    return textDecoder.decode(decrypted);
  } catch (error) {
    return '[Unable to decrypt]';
  }
}


function MessageBubble({ message, authUserId, privateKey }) {
  const mine = message.fromUserId === authUserId;
  const [decryptedText, setDecryptedText] = useState('[Decrypting...]');

  useEffect(() => {
    let alive = true;
    decryptMessage(message, authUserId, privateKey).then((text) => {
      if (alive) {
        setDecryptedText(text);
      }
    });

    return () => {
      alive = false;
    };
  }, [message, authUserId, privateKey]);

  return (
    <div className={`message ${mine ? 'me' : 'them'}`}>
      <div>{decryptedText}</div>
      <span className="message-time">{new Date(message.timestamp).toLocaleTimeString()}</span>
    </div>
  );
}

function App() {
  const [auth, setAuth] = useState(() => {
    const raw = localStorage.getItem('chat-auth');
    return raw ? JSON.parse(raw) : null;
  });
  const [users, setUsers] = useState([]);
  const [activeUserId, setActiveUserId] = useState('');
  const [messages, setMessages] = useState([]);
  const [socket, setSocket] = useState(null);
  const [error, setError] = useState('');
  const [keysReady, setKeysReady] = useState(false);
  const [privateKey, setPrivateKey] = useState(null);
  const [publicKeyBase64, setPublicKeyBase64] = useState('');

  const activeUser = useMemo(() => users.find((u) => u.id === activeUserId), [users, activeUserId]);

  useEffect(() => {
    if (!auth) {
      return;
    }

    let active = true;

    async function setupE2EE() {
      try {
        const keyMaterial = await loadOrCreateKeyMaterial(auth.user.id);
        const importedPrivate = keyMaterial.privateKeyCrypto;
        const exportedPublic = keyMaterial.publicKeyBase64;

        if (!active) {
          return;
        }

        setPrivateKey(importedPrivate);
        setPublicKeyBase64(exportedPublic);

        await fetch('/api/me/public-key', {
          method: 'PUT',
          headers: {
            Authorization: `Bearer ${auth.token}`,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({ publicKey: exportedPublic })
        });

        setKeysReady(true);
      } catch (err) {
        setError('Unable to initialize end-to-end encryption keys.');
      }
    }

    setupE2EE();

    return () => {
      active = false;
    };
  }, [auth]);

  useEffect(() => {
    if (!auth || !keysReady) {
      return;
    }

    localStorage.setItem('chat-auth', JSON.stringify(auth));
    loadUsers(auth.token);

    const client = io({ auth: { token: auth.token } });

    client.on('connect_error', () => {
      setError('Socket connection failed. Please log in again.');
    });

    client.on('presence:update', (onlineUserIds) => {
      setUsers((prev) => prev.map((u) => ({ ...u, online: onlineUserIds.includes(u.id) })));
    });

    client.on('message:new', (message) => {
      const inCurrentThread =
        (message.fromUserId === auth.user.id && message.toUserId === activeUserId) ||
        (message.fromUserId === activeUserId && message.toUserId === auth.user.id);

      if (inCurrentThread) {
        setMessages((prev) => [...prev, message]);
      }
    });

    setSocket(client);

    return () => {
      client.disconnect();
      setSocket(null);
    };
  }, [auth, activeUserId, keysReady]);

  async function api(path, options = {}) {
    const headers = {
      'Content-Type': 'application/json',
      ...(options.headers || {})
    };

    if (auth?.token) {
      headers.Authorization = `Bearer ${auth.token}`;
    }

    const res = await fetch(path, { ...options, headers });
    const body = await res.json().catch(() => ({}));

    if (!res.ok) {
      throw new Error(body.error || 'Request failed');
    }

    return body;
  }

  async function handleAuth(endpoint, formData) {
    setError('');
    try {
      const data = await api(`/api/${endpoint}`, {
        method: 'POST',
        body: JSON.stringify(formData)
      });
      setAuth(data);
      setUsers([]);
      setMessages([]);
      setActiveUserId('');
      setKeysReady(false);
    } catch (err) {
      setError(err.message);
    }
  }

  async function loadUsers(tokenOverride) {
    try {
      const token = tokenOverride || auth?.token;
      if (!token) {
        return;
      }

      const res = await fetch('/api/users', {
        headers: { Authorization: `Bearer ${token}` }
      });
      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || 'Unable to load users');
      }
      setUsers(data.users);
      if (!activeUserId && data.users[0]) {
        setActiveUserId(data.users[0].id);
      }
    } catch (err) {
      setError(err.message);
    }
  }

  async function loadMessages(otherUserId) {
    try {
      const data = await api(`/api/messages/${otherUserId}`);
      setMessages(data.messages);
    } catch (err) {
      setError(err.message);
    }
  }

  useEffect(() => {
    if (activeUserId) {
      loadMessages(activeUserId);
    } else {
      setMessages([]);
    }
  }, [activeUserId]);

  function logout() {
    localStorage.removeItem('chat-auth');
    setAuth(null);
    setUsers([]);
    setMessages([]);
    setActiveUserId('');
    setPrivateKey(null);
    setPublicKeyBase64('');
    setKeysReady(false);
  }

  async function sendMessage(event) {
    event.preventDefault();
    const input = event.target.elements.message;
    const text = input.value.trim();

    if (!text || !activeUserId || !socket || !privateKey || !keysReady) {
      return;
    }

    const recipient = users.find((u) => u.id === activeUserId);
    if (!recipient?.publicKey) {
      setError('Recipient has no encryption key registered yet.');
      return;
    }

    try {
      const encryptedPayload = await encryptMessage(text, publicKeyBase64, recipient.publicKey);
      socket.emit('message:send', { toUserId: activeUserId, encryptedPayload });
      input.value = '';
    } catch (err) {
      setError('Failed to encrypt and send message.');
    }
  }

  if (!auth) {
    return <AuthView onAuth={handleAuth} error={error} />;
  }

  return (
    <div className="container">
      <div className="card">
        <h1>Real-time Chat</h1>
        <p>
          Logged in as <strong>{auth.user.username}</strong>
        </p>
        <p>
          <small>Messages are encrypted on the client with AES-GCM + RSA-OAEP.</small>
        </p>
        <button onClick={logout}>Logout</button>

        <div className="chat-layout" style={{ marginTop: 16 }}>
          <div>
            <h3>Users</h3>
            <div className="user-list">
              {users.length === 0 ? (
                <p>No users available yet. Open another browser and register a second user.</p>
              ) : (
                users.map((u) => (
                  <div
                    className={`user-item ${u.id === activeUserId ? 'active' : ''}`}
                    key={u.id}
                    onClick={() => setActiveUserId(u.id)}
                  >
                    <span>{u.username}</span>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                      {!u.hasPublicKey ? <small style={{ color: '#9f1239' }}>No key</small> : null}
                      <span className={`status-dot ${u.online ? 'online' : ''}`} />
                    </div>
                  </div>
                ))
              )}
            </div>
          </div>

          <div>
            <h3>{activeUser ? `Chat with ${activeUser.username}` : 'Select a user'}</h3>
            <div className="messages">
              {messages.map((m) => (
                <MessageBubble key={m.id} message={m} authUserId={auth.user.id} privateKey={privateKey} />
              ))}
            </div>

            <form onSubmit={sendMessage} style={{ marginTop: 10 }}>
              <input name="message" placeholder="Type a message" autoComplete="off" />
              <button type="submit" disabled={!activeUserId || !keysReady}>
                Send
              </button>
            </form>
          </div>
        </div>

        {error ? <p className="error">{error}</p> : null}
      </div>
    </div>
  );
}

function AuthView({ onAuth, error }) {
  const [loginForm, setLoginForm] = useState({ username: '', password: '' });
  const [registerForm, setRegisterForm] = useState({ username: '', password: '' });

  return (
    <div className="container">
      <div className="card">
        <h1>Welcome to Socket Chat</h1>
        <div className="auth-grid">
          <section>
            <h2>Login</h2>
            <form
              onSubmit={(e) => {
                e.preventDefault();
                onAuth('login', loginForm);
              }}
            >
              <input
                placeholder="Username"
                value={loginForm.username}
                onChange={(e) => setLoginForm((p) => ({ ...p, username: e.target.value }))}
              />
              <input
                type="password"
                placeholder="Password"
                value={loginForm.password}
                onChange={(e) => setLoginForm((p) => ({ ...p, password: e.target.value }))}
              />
              <button type="submit">Login</button>
            </form>
          </section>

          <section>
            <h2>Register</h2>
            <form
              onSubmit={(e) => {
                e.preventDefault();
                onAuth('register', registerForm);
              }}
            >
              <input
                placeholder="Username"
                value={registerForm.username}
                onChange={(e) => setRegisterForm((p) => ({ ...p, username: e.target.value }))}
              />
              <input
                type="password"
                placeholder="Password"
                value={registerForm.password}
                onChange={(e) => setRegisterForm((p) => ({ ...p, password: e.target.value }))}
              />
              <button type="submit">Register</button>
            </form>
          </section>
        </div>

        {error ? <p className="error">{error}</p> : null}
      </div>
    </div>
  );
}

const root = ReactDOM.createRoot(document.getElementById('root'));
root.render(<App />);
