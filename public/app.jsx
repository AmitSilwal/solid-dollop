const { useEffect, useMemo, useState } = React;

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

  const activeUser = useMemo(() => users.find((u) => u.id === activeUserId), [users, activeUserId]);

  useEffect(() => {
    if (!auth) {
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
  }, [auth, activeUserId]);

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
  }

  function sendMessage(event) {
    event.preventDefault();
    const input = event.target.elements.message;
    const text = input.value.trim();

    if (!text || !activeUserId || !socket) {
      return;
    }

    socket.emit('message:send', { toUserId: activeUserId, text });
    input.value = '';
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
                    <span className={`status-dot ${u.online ? 'online' : ''}`} />
                  </div>
                ))
              )}
            </div>
          </div>

          <div>
            <h3>{activeUser ? `Chat with ${activeUser.username}` : 'Select a user'}</h3>
            <div className="messages">
              {messages.map((m) => {
                const mine = m.fromUserId === auth.user.id;
                return (
                  <div key={m.id} className={`message ${mine ? 'me' : 'them'}`}>
                    <div>{m.text}</div>
                    <span className="message-time">{new Date(m.timestamp).toLocaleTimeString()}</span>
                  </div>
                );
              })}
            </div>

            <form onSubmit={sendMessage} style={{ marginTop: 10 }}>
              <input name="message" placeholder="Type a message" autoComplete="off" />
              <button type="submit" disabled={!activeUserId}>
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
