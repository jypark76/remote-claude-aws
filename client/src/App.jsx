import { useState, useEffect } from "react";
import { login } from "./auth";
import { API_URL, UPLOAD_URL_ENDPOINT, CHATS_URL } from "./config";
import "./App.css";

function LoginScreen({ onLogin }) {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");

  async function handleSubmit(e) {
    e.preventDefault();
    setError("");
    try {
      const token = await login(username, password);
      onLogin(token);
    } catch (err) {
      setError("Wrong username or password.");
    }
  }

  return (
    <form onSubmit={handleSubmit} className="login-screen">
      <h1>S&amp;D Bot</h1>
      <input value={username} onChange={(e) => setUsername(e.target.value)} placeholder="Username" />
      <input value={password} onChange={(e) => setPassword(e.target.value)} type="password" placeholder="Password" />
      <button type="submit">Sign In</button>
      {error && <p className="error">{error}</p>}
    </form>
  );
}

function timeAgo(unixSeconds) {
  return new Date(unixSeconds * 1000).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function ChatListScreen({ token, onOpenChat, onNewChat }) {
  const [chats, setChats] = useState([]);
  const [loading, setLoading] = useState(true);

  async function loadChats() {
    setLoading(true);
    const res = await fetch(CHATS_URL, { headers: { Authorization: token } });
    const data = await res.json();
    setChats(data.chats || []);
    setLoading(false);
  }

  useEffect(() => {
    loadChats();
  }, []);

  async function deleteChat(e, chatId, title) {
    e.stopPropagation();
    if (!confirm(`Delete "${title}"?`)) return;
    await fetch(`${CHATS_URL}/${chatId}`, { method: "DELETE", headers: { Authorization: token } });
    loadChats();
  }

  async function renameChat(e, chatId, oldTitle) {
    e.stopPropagation();
    const newTitle = prompt("Rename chat:", oldTitle);
    if (!newTitle || newTitle === oldTitle) return;
    await fetch(`${CHATS_URL}/${chatId}`, {
      method: "PATCH",
      headers: { "content-type": "application/json", Authorization: token },
      body: JSON.stringify({ title: newTitle }),
    });
    loadChats();
  }

  return (
    <div className="list-screen">
      <div className="list-header">
        <h1>S&amp;D Bot</h1>
        <button className="new-btn" onClick={onNewChat}>+</button>
      </div>
      <div className="chat-list">
        {loading && <p className="empty-note">Loading...</p>}
        {!loading && chats.length === 0 && <p className="empty-note">No chats yet. Tap + to start one.</p>}
        {chats.map((c) => (
          <div key={c.chat_id} className="chat-row" onClick={() => onOpenChat(c.chat_id)}>
            <div className="chat-avatar">🤖</div>
            <div className="chat-info">
              <div className="chat-title">{c.title}</div>
            </div>
            <div className="chat-time">{timeAgo(c.updated_at)}</div>
            <button className="icon-btn" onClick={(e) => renameChat(e, c.chat_id, c.title)}>✏️</button>
            <button className="icon-btn del-btn" onClick={(e) => deleteChat(e, c.chat_id, c.title)}>🗑</button>
          </div>
        ))}
      </div>
    </div>
  );
}

function ChatScreen({ token, chatId: initialChatId, onBack }) {
  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState("");
  const [thinking, setThinking] = useState(false);
  const [chatId, setChatId] = useState(initialChatId);

  useEffect(() => {
    if (!initialChatId) return;
    fetch(`${CHATS_URL}/${initialChatId}`, { headers: { Authorization: token } })
      .then((r) => r.json())
      .then((data) => {
        setMessages(data.messages.map((m) => ({ role: m.role === "user" ? "user" : "claude", text: m.content })));
      });
  }, [initialChatId]);

  async function sendMessage() {
    const text = input.trim();
    if (!text) return;
    setMessages((m) => [...m, { role: "user", text }]);
    setInput("");
    setThinking(true);

    try {
      const res = await fetch(API_URL, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          Authorization: token,
        },
        body: JSON.stringify({ message: text, chat_id: chatId }),
      });
      const data = await res.json();
      setChatId(data.chat_id);
      setMessages((m) => [...m, { role: "claude", text: data.reply }]);
    } catch (err) {
      setMessages((m) => [...m, { role: "claude", text: "Error: " + err.message }]);
    }
    setThinking(false);
  }

  async function uploadFile(file) {
    setMessages((m) => [...m, { role: "user", text: "Attached: " + file.name }]);

    const res = await fetch(UPLOAD_URL_ENDPOINT, {
      method: "POST",
      headers: { "content-type": "application/json", Authorization: token },
      body: JSON.stringify({ chat_id: chatId, filename: file.name, content_type: file.type }),
    });
    const data = await res.json();
    setChatId(data.chat_id);

    await fetch(data.upload_url, {
      method: "PUT",
      headers: { "content-type": file.type },
      body: file,
    });

    setMessages((m) => [...m, { role: "claude", text: "Saved to S3 as " + data.key }]);
  }

  return (
    <div className="chat-screen">
      <div className="chat-header">
        <button className="back-btn" onClick={onBack}>&lsaquo; Back</button>
      </div>
      <div className="messages">
        {messages.map((m, i) => (
          <div key={i} className={"bubble-wrap " + (m.role === "user" ? "me" : "them")}>
            <div className="bubble">{m.text}</div>
          </div>
        ))}
        {thinking && <div className="thinking">Thinking...</div>}
      </div>
      <div className="input-row">
        <label className="attach-btn">
          📎
          <input
            type="file"
            style={{ display: "none" }}
            onChange={(e) => {
              if (e.target.files[0]) uploadFile(e.target.files[0]);
              e.target.value = "";
            }}
          />
        </label>
        <textarea
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              sendMessage();
            }
          }}
          placeholder="Message..."
        />
        <button onClick={sendMessage}>Send</button>
      </div>
    </div>
  );
}

export default function App() {
  const [token, setToken] = useState(null);
  const [view, setView] = useState("list"); // 'list' | 'chat'
  const [activeChatId, setActiveChatId] = useState(null);

  if (!token) return <LoginScreen onLogin={setToken} />;

  if (view === "chat") {
    return (
      <ChatScreen
        token={token}
        chatId={activeChatId}
        onBack={() => setView("list")}
      />
    );
  }

  return (
    <ChatListScreen
      token={token}
      onOpenChat={(id) => {
        setActiveChatId(id);
        setView("chat");
      }}
      onNewChat={() => {
        setActiveChatId(null);
        setView("chat");
      }}
    />
  );
}
