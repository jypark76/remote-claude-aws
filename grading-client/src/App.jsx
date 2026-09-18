import { useState, useEffect, useRef, useCallback } from "react";
import { login, completeNewPassword } from "./auth";
import { API_BASE } from "./config";
import { useSocket } from "./useSocket";
import "./App.css";

function decodeClaims(token) {
  try {
    return JSON.parse(atob(token.split(".")[1]));
  } catch {
    return null;
  }
}
function decodeUsername(token) {
  const payload = decodeClaims(token);
  return payload ? payload["cognito:username"] || payload.username || "" : "";
}
function getStoredToken() {
  const token = localStorage.getItem("userToken");
  if (!token) return null;
  const claims = decodeClaims(token);
  if (!claims || !claims.exp || claims.exp * 1000 <= Date.now()) {
    localStorage.removeItem("userToken");
    return null;
  }
  return token;
}

async function api(path, token, opts = {}) {
  const res = await fetch(`${API_BASE}${path}`, {
    ...opts,
    headers: { "content-type": "application/json", Authorization: token, ...(opts.headers || {}) },
  });
  if (!res.ok) {
    let body = {};
    try {
      body = await res.json();
    } catch {}
    throw new Error(body.error || `HTTP ${res.status}`);
  }
  return res.json();
}

function timeAgo(ts) {
  return new Date(ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}
function fmtElapsed(ms) {
  const s = Math.floor(ms / 1000);
  return s < 60 ? s + "s" : Math.floor(s / 60) + "m " + (s % 60) + "s";
}
function fmtBytes(b) {
  if (b < 1024) return b + " B";
  if (b < 1024 * 1024) return (b / 1024).toFixed(1) + " KB";
  if (b < 1024 * 1024 * 1024) return (b / (1024 * 1024)).toFixed(1) + " MB";
  return (b / (1024 * 1024 * 1024)).toFixed(2) + " GB";
}
const FILE_ICONS = {
  xlsx: "📊", xls: "📊", csv: "📊", pdf: "📄", docx: "📝", doc: "📝", pptx: "📋",
  ppt: "📋", zip: "📦", png: "🖼️", jpg: "🖼️", jpeg: "🖼️", gif: "🖼️", txt: "📃",
  md: "📃", json: "📃", py: "📃", sh: "📃",
};
function fileIcon(name) {
  const ext = (name.split(".").pop() || "").toLowerCase();
  return FILE_ICONS[ext] || "📎";
}
const IMG_EXT = /\.(png|jpg|jpeg|gif|webp)$/i;

function Avatar({ incognito, ownerId, className }) {
  const [errored, setErrored] = useState(false);
  if (incognito) return <div className={className}>👻</div>;
  if (errored) return <div className={className}>👤</div>;
  return (
    <div className={className}>
      <img
        src={`${API_BASE}/avatars/${encodeURIComponent(ownerId || "admin")}.jpg`}
        alt={ownerId}
        style={{ width: "100%", height: "100%", objectFit: "cover", borderRadius: "50%" }}
        onError={() => setErrored(true)}
      />
    </div>
  );
}

function stripAnsi(s) {
  return s
    .replace(/\x1b\[[0-9;?<=>]*[A-Za-z]/g, "")
    .replace(/\x1b\][^\x07\x1b]*(\x07|\x1b\\)/g, "")
    .replace(/[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/g, "")
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, "");
}

const TOOL_VERBS = {
  Edit: "Editing", Write: "Writing", Read: "Reading", Bash: "Running",
  Grep: "Searching", Glob: "Scanning", WebFetch: "Fetching", WebSearch: "Searching",
  Agent: "Delegating",
};

const EVAL_MARKERS = ["__OFF_TOPIC__", "__INJECTION_REJECTED__", "__EXCESSIVE_WORK_REJECTED__"];
function stripEvalMarkers(text) {
  if (!text) return text;
  let out = text;
  for (const m of EVAL_MARKERS) out = out.split(m).join("");
  return out.trim();
}

const APPROVE_MARKER = "__ASK_APPROVE_REJECT__";
function stripApproveMarker(text) {
  text = stripEvalMarkers(text);
  if (!text || !text.includes(APPROVE_MARKER)) return { text, askApproveReject: false };
  return { text: text.split(APPROVE_MARKER).join("").trim(), askApproveReject: true };
}

// ---------------- Login ----------------
function LoginScreen({ onLogin }) {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [newPasswordUser, setNewPasswordUser] = useState(null);
  const [newPassword, setNewPassword] = useState("");

  async function handleSubmit(e) {
    e.preventDefault();
    setError("");
    try {
      const result = await login(username, password);
      if (result.newPasswordRequired) setNewPasswordUser(result.user);
      else onLogin(result.token);
    } catch {
      setError("Wrong username or password.");
    }
  }

  async function handleNewPassword(e) {
    e.preventDefault();
    setError("");
    try {
      const token = await completeNewPassword(newPasswordUser, newPassword);
      onLogin(token);
    } catch (err) {
      setError(err.message || "Could not set new password.");
    }
  }

  if (newPasswordUser) {
    return (
      <form onSubmit={handleNewPassword} className="login-screen">
        <h1>Set a new password</h1>
        <input value={newPassword} onChange={(e) => setNewPassword(e.target.value)} type="password" placeholder="New password" />
        <button type="submit">Set password</button>
        {error && <p id="login-err">{error}</p>}
      </form>
    );
  }

  return (
    <form onSubmit={handleSubmit} className="login-screen">
      <img src={`${API_BASE}/avatars/wgu-owl.webp`} alt="remote_claude" className="login-logo" />
      <h1 className="login-title">AI Assessment Grader</h1>
      <input value={username} onChange={(e) => setUsername(e.target.value)} placeholder="Username" autoCapitalize="none" />
      <input value={password} onChange={(e) => setPassword(e.target.value)} type="password" placeholder="Password" />
      <button type="submit">Sign In</button>
      {error && <p id="login-err">{error}</p>}
    </form>
  );
}

// ---------------- Chat list ----------------
function ChatListScreen({ token, username, role, socket, onOpen, onLogout, onOpenTables }) {
  const [chats, setChats] = useState([]);
  const [meta, setMeta] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [search, setSearch] = useState("");
  const [menuOpen, setMenuOpen] = useState(false);
  const [sortField, setSortField] = useState(localStorage.getItem("sortField") || "updated");
  const [sortDir, setSortDir] = useState(localStorage.getItem("sortDir") || "desc");
  const [storage, setStorage] = useState(null);
  const [liveVerbs, setLiveVerbs] = useState({});
  const [stats, setStats] = useState(null);
  const [killing, setKilling] = useState(false);
  const dragSrc = useRef(null);
  const [dragOverId, setDragOverId] = useState(null);

  useEffect(() => {
    if (role !== "admin") return;
    let cancelled = false;
    function poll() {
      api("/api/stats", token).then((d) => !cancelled && setStats(d)).catch(() => {});
    }
    poll();
    const t = setInterval(poll, 5000);
    return () => { cancelled = true; clearInterval(t); };
  }, [role, token]);

  async function killServer() {
    if (!window.confirm("Shut down the server?")) return;
    if (!window.confirm("Are you sure? All running chats will stop.")) return;
    setKilling(true);
    await api("/api/shutdown", token, { method: "POST" }).catch(() => {});
    window.alert("Server restarting (systemd will bring it back in a few seconds)...");
  }

  const load = useCallback(async () => {
    setLoading(true);
    setError(false);
    try {
      const data = await api("/api/chats", token);
      setChats(data.chats || []);
      setMeta(data.meta || null);
    } catch {
      setError(true);
    }
    setLoading(false);
  }, [token]);

  useEffect(() => {
    load();
    api("/api/storage", token).then(setStorage).catch(() => {});
  }, [load, token]);

  useEffect(() => {
    return socket.subscribe((msg) => {
      if (msg.type === "storage_update") setStorage(msg);
      if (msg.type === "output" || msg.type === "tool_use") {
        const verb =
          msg.type === "tool_use"
            ? (TOOL_VERBS[msg.text.split("(")[0]] || "Working") + "…"
            : "Writing…";
        setLiveVerbs((v) => ({ ...v, [msg.chatId]: verb }));
      }
      if (msg.type === "response_done") {
        setLiveVerbs((v) => {
          const n = { ...v };
          delete n[msg.chatId];
          return n;
        });
        load();
      }
      if (msg.type === "chat_deleted") load();
    });
  }, [socket, load]);

  useEffect(() => {
    localStorage.setItem("sortField", sortField);
    localStorage.setItem("sortDir", sortDir);
  }, [sortField, sortDir]);

  async function newChat() {
    const input = window.prompt("Chat name (or leave blank):");
    if (input === null) return;
    const title = input.trim() || "Chat " + new Date().toLocaleString();
    try {
      const chat = await api("/api/chats", token, { method: "POST", body: JSON.stringify({ title }) });
      onOpen(chat.id);
    } catch {
      load();
    }
  }

  async function newIncognito() {
    try {
      const chat = await api("/api/chats", token, {
        method: "POST",
        body: JSON.stringify({ title: "Incognito", incognito: true }),
      });
      onOpen(chat.id);
    } catch {
      load();
    }
  }

  async function deleteChat(e, c) {
    e.stopPropagation();
    if (!window.confirm(`Delete "${c.title}"?`)) return;
    await api(`/api/chats/${c.id}/stop`, token, { method: "POST" }).catch(() => {});
    await api(`/api/chats/${c.id}`, token, { method: "DELETE" }).catch(() => {});
    load();
  }

  function sortChats(list) {
    if (sortField === "custom") return list;
    const sorted = [...list].sort((a, b) => {
      let av, bv;
      if (sortField === "created") { av = a.createdAt || 0; bv = b.createdAt || 0; }
      else if (sortField === "name") { av = (a.incognito ? "incognito" : a.title).toLowerCase(); bv = (b.incognito ? "incognito" : b.title).toLowerCase(); }
      else if (sortField === "owner") { av = (a.incognito ? "incognito" : a.ownerId || "admin").toLowerCase(); bv = (b.incognito ? "incognito" : b.ownerId || "admin").toLowerCase(); }
      else if (sortField === "thinking") { av = a.isRunning ? 1 : 0; bv = b.isRunning ? 1 : 0; }
      else { av = a.updatedAt || 0; bv = b.updatedAt || 0; }
      if (av < bv) return sortDir === "asc" ? -1 : 1;
      if (av > bv) return sortDir === "asc" ? 1 : -1;
      return 0;
    });
    return sorted;
  }

  const q = search.trim().toLowerCase();
  const filtered = q ? chats.filter((c) => (c.title || "").toLowerCase().includes(q)) : chats;
  const visible = sortChats(filtered);

  function onDrop(targetId) {
    if (!dragSrc.current || dragSrc.current === targetId) {
      setDragOverId(null);
      return;
    }
    const ids = visible.map((c) => c.id);
    const from = ids.indexOf(dragSrc.current);
    const to = ids.indexOf(targetId);
    ids.splice(to, 0, ids.splice(from, 1)[0]);
    const reordered = ids.map((id) => chats.find((c) => c.id === id)).filter(Boolean);
    setChats(reordered);
    setSortField("custom");
    api("/api/chat-order", token, { method: "PATCH", body: JSON.stringify({ ids }) }).catch(() => {});
    dragSrc.current = null;
    setDragOverId(null);
  }

  function moveToTop(e, id) {
    e.stopPropagation();
    const ids = visible.map((c) => c.id);
    const idx = ids.indexOf(id);
    if (idx <= 0) return;
    ids.splice(idx, 1);
    ids.unshift(id);
    const reordered = ids.map((cid) => chats.find((c) => c.id === cid)).filter(Boolean);
    setChats(reordered);
    setSortField("custom");
    api("/api/chat-order", token, { method: "PATCH", body: JSON.stringify({ ids }) }).catch(() => {});
  }

  return (
    <div id="list-screen">
      <div id="list-header">
        <h1>
          <button className="icon-btn-sm" onClick={load} title="Refresh">&#8635;</button>
          <button className="icon-btn-sm" onClick={() => setMenuOpen((v) => !v)} title="Sort & Search">
            <span className={"menu-arrow" + (menuOpen ? " open" : "")}>&#9660;</span>
          </button>
          {role === "admin" && stats && (
            <span className="incognito-watch">&#128123; {stats.activeIncognito}/{stats.totalUsers}</span>
          )}
        </h1>
        <div id="list-header-btns">
          {role === "admin" && (
            <button className="kill-btn" onClick={killServer} disabled={killing} title="Shut down the server">Kill</button>
          )}
          <button className="text-btn" onClick={onLogout} title="Logout">Logout</button>
          <button className="new-btn round" onClick={newIncognito} title="Incognito chat">&#128123;</button>
          <button className="new-btn round" onClick={onOpenTables} title="Browse database tables">&#128452;&#65039;</button>
          <button className="new-btn round" onClick={newChat} title="New chat">+</button>
        </div>
      </div>

      {storage && (
        <div id="storage-bar">
          <div id="storage-track">
            <div
              id="storage-fill"
              style={{
                width: `${Math.min(storage.percent, 100)}%`,
                background: storage.percent < 60 ? "#30d158" : storage.percent < 85 ? "#ffd60a" : "#ff453a",
              }}
            />
          </div>
          <div id="storage-label">
            <span>{fmtBytes(storage.bytes)}{storage.total ? " of " + fmtBytes(storage.total) : ""}</span>
            <span>{storage.percent.toFixed(1)}%</span>
          </div>
        </div>
      )}

      <div className={"slide-bar" + (menuOpen ? " open" : "")}>
        <div className="sort-inner">
          <span>Sort:</span>
          <select value={sortField} onChange={(e) => setSortField(e.target.value)}>
            <option value="updated">Updated</option>
            <option value="created">Created</option>
            <option value="name">Name</option>
            <option value="owner">Owner</option>
            <option value="thinking">Thinking</option>
            <option value="custom">Manual</option>
          </select>
          <button id="sort-dir" onClick={() => setSortDir((d) => (d === "asc" ? "desc" : "asc"))}>
            {sortDir === "asc" ? "↑" : "↓"}
          </button>
          <div id="chat-search-wrap">
            <input id="chat-search" placeholder="Search…" value={search} onChange={(e) => setSearch(e.target.value)} />
            {search && <button className="search-clear" onClick={() => setSearch("")}>✕</button>}
          </div>
        </div>
      </div>

      <div id="chat-list">
        {loading && <p className="empty-note">Loading...</p>}
        {error && <p className="empty-note error-note">Could not load chats.<br />Is the server up?</p>}
        {!loading && !error && visible.length === 0 && (
          <p className="empty-note">No chats yet.<br />Tap + to start one.</p>
        )}
        {!loading && !error && visible.map((c) => {
          const running = c.isRunning || liveVerbs[c.id];
          const canDelete = role === "admin" || c.ownerId === username;
          return (
            <div
              key={c.id}
              className={"chat-row" + (dragOverId === c.id ? " drag-over-top" : "")}
              draggable
              onDragStart={() => (dragSrc.current = c.id)}
              onDragOver={(e) => { e.preventDefault(); setDragOverId(c.id); }}
              onDragLeave={() => setDragOverId((v) => (v === c.id ? null : v))}
              onDrop={() => onDrop(c.id)}
              onClick={() => onOpen(c.id)}
            >
              <Avatar incognito={c.incognito} ownerId={c.ownerId} className="chat-avatar" />
              <div className="chat-info">
                <div className="chat-title">{c.incognito ? "Incognito" : c.title}</div>
                <div className="chat-preview">
                  {running ? (
                    <span className="live-verb">✶ {liveVerbs[c.id] || "Thinking…"}</span>
                  ) : (
                    c.preview || "No messages yet"
                  )}
                </div>
              </div>
              <div className="chat-time">{timeAgo(c.updatedAt)}</div>
              {canDelete && (
                <button className="del-btn" title="Delete" onClick={(e) => deleteChat(e, c)}>&#128465;</button>
              )}
              <span className="drag-handle" title="Move to top" onClick={(e) => moveToTop(e, c.id)}>&#8942;</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ---------------- Database browser (read-only) ----------------
function TablesScreen({ token, onOpen, onBack }) {
  const [tables, setTables] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [exporting, setExporting] = useState(false);

  useEffect(() => {
    api("/api/tables", token)
      .then((d) => setTables(d.tables || []))
      .catch(() => setError(true))
      .finally(() => setLoading(false));
  }, [token]);

  function exportCsv() {
    setExporting(true);
    const url = `${API_BASE}/api/tables/export?token=${encodeURIComponent(token)}`;
    const a = document.createElement("a");
    a.href = url;
    a.download = "database_export.csv";
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => setExporting(false), 800);
  }

  return (
    <div id="list-screen">
      <div id="list-header">
        <div className="chat-header-left">
          <button id="back-btn" onClick={onBack}>&#8249; Back</button>
        </div>
        <h1>Database tables</h1>
        <button className="icon-btn-sm" onClick={exportCsv} disabled={exporting} title="Export all tables as CSV">
          &#128230;
        </button>
      </div>
      <div id="chat-list">
        {loading && <p className="empty-note">Loading...</p>}
        {error && <p className="empty-note error-note">Could not load tables.</p>}
        {!loading && !error && tables.length === 0 && <p className="empty-note">No tables found.</p>}
        {!loading && !error && tables.map((t) => (
          <div key={t} className="chat-row" onClick={() => onOpen(t)}>
            <div className="chat-avatar">&#128451;&#65039;</div>
            <div className="chat-info">
              <div className="chat-title">{t}</div>
              <div className="chat-preview">read-only</div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function TableDetailScreen({ token, tableName, onBack }) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [cellView, setCellView] = useState(null);

  useEffect(() => {
    setLoading(true);
    setError(false);
    api(`/api/tables/${encodeURIComponent(tableName)}`, token)
      .then(setData)
      .catch(() => setError(true))
      .finally(() => setLoading(false));
  }, [token, tableName]);

  return (
    <div id="chat-screen">
      <div id="chat-header">
        <div className="chat-header-left">
          <button id="back-btn" onClick={onBack}>&#8249; Back</button>
        </div>
        <div className="chat-header-center">
          <span id="chat-title-el">{tableName}</span>
        </div>
        <span style={{ width: 50 }} />
      </div>
      <div className="db-table-wrap">
        {loading && <p className="empty-note">Loading...</p>}
        {error && <p className="empty-note error-note">Could not load this table.</p>}
        {data && data.rows.length === 0 && <p className="empty-note">No rows.</p>}
        {data && data.rows.length > 0 && (
          <div className="db-table-scroll">
            <table className="db-table">
              <thead>
                <tr>{data.columns.map((c) => <th key={c}>{c}</th>)}</tr>
              </thead>
              <tbody>
                {data.rows.map((row, i) => (
                  <tr key={i}>
                    {row.map((v, j) => (
                      <td
                        key={j}
                        className="db-cell"
                        onClick={() => v !== null && setCellView({ column: data.columns[j], value: v })}
                      >
                        {v === null ? <span className="null-val">null</span> : String(v)}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {cellView && (
        <div className="modal-backdrop" onClick={(e) => e.target === e.currentTarget && setCellView(null)}>
          <div className="modal-card">
            <div className="modal-title">{cellView.column}</div>
            <pre className="cell-full-value">{cellView.value}</pre>
            <button className="modal-close" onClick={() => setCellView(null)}>Close</button>
          </div>
        </div>
      )}
    </div>
  );
}

// ---------------- Pin modal ----------------
function PinModal({ token, chatId, onClose }) {
  const [pinned, setPinned] = useState([]);
  const [available, setAvailable] = useState([]);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const r = await api(`/api/chats/${chatId}/pins`, token);
      setPinned(r.pinned || []);
      setAvailable(r.available || []);
    } catch {}
    setLoading(false);
  }, [token, chatId]);

  useEffect(() => { load(); }, [load]);

  async function pin(name) {
    try {
      await api(`/api/chats/${chatId}/pins`, token, { method: "POST", body: JSON.stringify({ item: name }) });
      load();
    } catch (e) {
      window.alert("Failed to pin: " + e.message);
    }
  }
  async function unpin(name) {
    if (!window.confirm(`Unpin "${name}"? It stays in the chat folder but leaves the git repo.`)) return;
    try {
      await api(`/api/chats/${chatId}/pins/${encodeURIComponent(name)}`, token, { method: "DELETE" });
      load();
    } catch (e) {
      window.alert("Failed to unpin: " + e.message);
    }
  }

  const unpinnedSet = new Set(pinned);
  const unpinnedItems = available.filter((a) => !unpinnedSet.has(a.name));

  return (
    <div className="modal-backdrop" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal-card">
        <div className="modal-title">Pinned Files</div>
        <div>
          <div className="modal-section-label">Pinned</div>
          <div className="modal-list">
            {loading && <span className="modal-empty">Loading...</span>}
            {!loading && pinned.length === 0 && <span className="modal-empty">No pinned files</span>}
            {!loading && pinned.map((name) => {
              const item = available.find((a) => a.name === name);
              return (
                <div key={name} className="pin-row">
                  <span>{item?.isDir ? "📁" : fileIcon(name)}</span>
                  <a
                    className="pin-label link"
                    href={`${API_BASE}/api/chats/${chatId}/files/${encodeURIComponent(name)}?token=${encodeURIComponent(token)}`}
                  >
                    {name}
                  </a>
                  <button className="pin-remove" onClick={() => unpin(name)}>✕</button>
                </div>
              );
            })}
          </div>
        </div>
        <div>
          <div className="modal-section-label">Available to Pin</div>
          <div className="modal-list">
            {!loading && unpinnedItems.length === 0 && <span className="modal-empty">No files in this chat</span>}
            {unpinnedItems.map((a) => (
              <div key={a.name} className="pin-row">
                <span>{a.isDir ? "📁" : fileIcon(a.name)}</span>
                <span className="pin-label">{a.name}</span>
                <button className="pin-add" onClick={() => pin(a.name)}>+</button>
              </div>
            ))}
          </div>
        </div>
        <button className="modal-close" onClick={onClose}>Close</button>
      </div>
    </div>
  );
}

// ---------------- Sweep modal ----------------
function SweepModal({ token, chatId, onClose }) {
  const [days, setDays] = useState(30);
  const [status, setStatus] = useState("");
  const [canDelete, setCanDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const timerRef = useRef(null);

  const preview = useCallback(async (d) => {
    setStatus("…");
    setCanDelete(false);
    try {
      const r = await api(`/api/chats/${chatId}/cleanup-preview`, token, { method: "POST", body: JSON.stringify({ days: d }) });
      if (r.count > 0) {
        setStatus("to save " + fmtBytes(r.bytes));
        setCanDelete(true);
      } else {
        setStatus("— nothing to delete");
      }
    } catch {
      setStatus("error");
    }
  }, [token, chatId]);

  useEffect(() => { preview(days); }, []); // eslint-disable-line

  function onDaysChange(v) {
    setDays(v);
    clearTimeout(timerRef.current);
    setCanDelete(false);
    setStatus("…");
    timerRef.current = setTimeout(() => preview(Number(v) || 0), 600);
  }

  async function confirmDelete() {
    setDeleting(true);
    try {
      const r = await api(`/api/chats/${chatId}/cleanup`, token, { method: "POST", body: JSON.stringify({ days: Number(days) || 0 }) });
      setStatus("freed " + fmtBytes(r.freed));
      setTimeout(onClose, 1200);
    } catch {
      setStatus("error");
      setDeleting(false);
    }
  }

  return (
    <div className="modal-backdrop" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal-card">
        <div className="modal-title">Clean up files</div>
        <div className="sweep-row">
          <span>Delete files older than</span>
          <input type="number" min="0" value={days} onChange={(e) => onDaysChange(e.target.value)} />
          <span>days</span>
          <span className="sweep-size">{status}</span>
        </div>
        <div className="modal-btn-row">
          <button className="modal-btn secondary" onClick={onClose}>Cancel</button>
          <button className="modal-btn danger" disabled={!canDelete || deleting} onClick={confirmDelete}>
            {deleting ? "Deleting..." : "Delete"}
          </button>
        </div>
      </div>
    </div>
  );
}

// ---------------- Chat screen ----------------
function ChatScreen({ token, username, chatId, socket, onBack, onDeleted }) {
  const [chat, setChat] = useState(null);
  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState("");
  const [selectedFiles, setSelectedFiles] = useState([]);
  const [thinking, setThinking] = useState(false);
  const [thinkStart, setThinkStart] = useState(0);
  const [thinkVerb, setThinkVerb] = useState("Thinking");
  const [elapsedLabel, setElapsedLabel] = useState("");
  const [showScrollBtn, setShowScrollBtn] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [msgQuery, setMsgQuery] = useState("");
  const [pinOpen, setPinOpen] = useState(false);
  const [sweepOpen, setSweepOpen] = useState(false);
  const [dropActive, setDropActive] = useState(false);
  const [recording, setRecording] = useState(false);
  const [exporting, setExporting] = useState(false);

  const messagesRef = useRef(null);
  const outputBufferRef = useRef("");
  const outputTimerRef = useRef(null);
  const fileInputRef = useRef(null);
  const recognitionRef = useRef(null);
  const dragCounterRef = useRef(0);
  const idCounter = useRef(0);
  const nextId = () => ++idCounter.current;

  const canWrite = chat ? username === "admin" || (chat.ownerId || "admin") === username : false;
  const chatRef = useRef(chat);
  chatRef.current = chat;

  useEffect(() => {
    function onPageHide() {
      if (chatRef.current?.incognito) {
        fetch(`${API_BASE}/api/chats/${chatId}`, { method: "DELETE", headers: { Authorization: token }, keepalive: true }).catch(() => {});
      }
    }
    window.addEventListener("pagehide", onPageHide);
    return () => window.removeEventListener("pagehide", onPageHide);
  }, [chatId, token]);

  async function handleBack() {
    if (chat?.incognito) {
      await api(`/api/chats/${chatId}`, token, { method: "DELETE" }).catch(() => {});
    }
    onBack();
  }

  function scrollToBottom() {
    requestAnimationFrame(() => {
      if (messagesRef.current) messagesRef.current.scrollTop = messagesRef.current.scrollHeight;
    });
  }

  function addBubble(role, text, ts, files, thinkMs, askApproveReject) {
    if (!text.trim() && !(files && files.length)) return;
    setMessages((m) => [...m, { id: nextId(), role, text, ts: ts || Date.now(), files: files || null, thinkMs: thinkMs || 0, askApproveReject: !!askApproveReject }]);
    scrollToBottom();
  }

  function flushOutput(done) {
    const text = outputBufferRef.current.trim();
    outputBufferRef.current = "";
    const rawMeaningful = text
      .split("\n")
      .filter((l) => !/^\s*[>❯]\s*$/.test(l))
      .join("\n")
      .trim();
    const { text: meaningful, askApproveReject } = stripApproveMarker(rawMeaningful);
    const elapsed = done && thinkStart ? Date.now() - thinkStart : 0;
    if (meaningful) addBubble("claude", meaningful, Date.now(), null, elapsed, askApproveReject);
    if (done) stopThinking();
  }

  function startThinking(verb) {
    setThinking(true);
    const start = Date.now();
    setThinkStart(start);
    setThinkVerb(verb || "Thinking…");
    scrollToBottom();
  }
  function stopThinking() {
    setThinking(false);
    setElapsedLabel("");
  }

  useEffect(() => {
    if (!thinking) return;
    const t = setInterval(() => setElapsedLabel(fmtElapsed(Date.now() - thinkStart)), 1000);
    return () => clearInterval(t);
  }, [thinking, thinkStart]);

  async function loadChat() {
    try {
      const c = await api(`/api/chats/${chatId}`, token);
      setChat(c);
      setMessages(
        (c.messages || []).map((m) => {
          const { text, askApproveReject } = stripApproveMarker(m.text);
          return { id: nextId(), role: m.role, text, ts: m.ts, files: m.files || null, thinkMs: m.thinkMs || 0, askApproveReject };
        })
      );
      if (c.isRunning) startThinking("Thinking…");
      scrollToBottom();
    } catch {
      setMessages([{ id: nextId(), role: "claude", text: "Failed to load chat.", ts: Date.now() }]);
    }
  }

  useEffect(() => {
    loadChat();
    socket.send({ type: "join", chatId });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chatId]);

  useEffect(() => {
    return socket.subscribe((msg) => {
      if (msg.chatId !== chatId) {
        if (msg.type === "chat_deleted" && msg.chatId === chatId) onDeleted();
        return;
      }
      if (msg.type === "output") {
        const clean = stripAnsi(msg.data);
        if (!clean.trim()) return;
        setThinkVerb("Writing…");
        outputBufferRef.current += clean;
        clearTimeout(outputTimerRef.current);
        outputTimerRef.current = setTimeout(() => flushOutput(false), 1200);
      } else if (msg.type === "tool_use") {
        const name = msg.text.split("(")[0];
        setThinkVerb((TOOL_VERBS[name] || "Working") + "…");
      } else if (msg.type === "response_done") {
        clearTimeout(outputTimerRef.current);
        flushOutput(true);
      } else if (msg.type === "files_update" && msg.files?.length) {
        showFiles(msg.files);
      } else if (msg.type === "chat_deleted") {
        onDeleted();
      }
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [socket, chatId, thinkStart]);

  function showFiles(files) {
    files.forEach(async (f) => {
      if (IMG_EXT.test(f)) {
        try {
          const url = `${API_BASE}/api/chats/${chatId}/files/${encodeURIComponent(f)}?token=${encodeURIComponent(token)}`;
          setMessages((m) => [...m, { id: nextId(), role: "claude", text: "", ts: Date.now(), imgUrl: url, imgLabel: f }]);
          scrollToBottom();
        } catch {}
      } else {
        setMessages((m) => [...m, { id: nextId(), role: "claude", text: "", ts: Date.now(), files: [f] }]);
        scrollToBottom();
      }
    });
  }

  async function doSend() {
    const text = input.trim();
    if (!canWrite) return;
    if (selectedFiles.length) {
      const names = selectedFiles.map((f) => f.name);
      addBubble("user", text, Date.now(), names.map((n) => ({ filename: n })));
      const files = selectedFiles;
      setSelectedFiles([]);
      startThinking("Thinking…");
      const fd = new FormData();
      files.forEach((f) => fd.append("file", f));
      if (text) fd.append("message", text);
      try {
        const res = await fetch(`${API_BASE}/api/chats/${chatId}/upload`, {
          method: "POST",
          headers: { Authorization: token },
          body: fd,
        });
        if (!res.ok) throw new Error(`upload failed: ${res.status}`);
      } catch {
        addBubble("claude", "Upload failed.", Date.now());
        stopThinking();
      }
    } else if (text) {
      sendChatText(text);
    }
    setInput("");
  }

  function sendChatText(text) {
    if (!canWrite || !text.trim() || thinking) return;
    addBubble("user", text, Date.now());
    socket.send({ type: "input", chatId, data: text + "\n", userToken: token });
    startThinking("Thinking…");
  }

  function handleApprove() {
    sendChatText("Approve it.");
  }

  function handleReject() {
    sendChatText("Reject it.");
  }

  async function stopRun() {
    await api(`/api/chats/${chatId}/stop`, token, { method: "POST" }).catch(() => {});
  }

  async function rename() {
    if (!canWrite || !chat) return;
    const newTitle = window.prompt("Rename chat:", chat.title);
    if (!newTitle || newTitle === chat.title) return;
    await api(`/api/chats/${chatId}`, token, { method: "PATCH", body: JSON.stringify({ title: newTitle }) });
    setChat((c) => ({ ...c, title: newTitle }));
  }

  async function doExport() {
    setExporting(true);
    try {
      const url = `${API_BASE}/api/chats/${chatId}/export?token=${encodeURIComponent(token)}`;
      const a = document.createElement("a");
      a.href = url;
      a.download = (chat?.dirName || "chat") + ".zip";
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
    } finally {
      setExporting(false);
    }
  }

  function addFiles(list) {
    setSelectedFiles((s) => [...s, ...Array.from(list)]);
  }
  function removeFile(i) {
    setSelectedFiles((s) => s.filter((_, idx) => idx !== i));
  }

  useEffect(() => {
    function onPaste(e) {
      const dt = e.clipboardData;
      if (!dt) return;
      const files = [...(dt.files || [])];
      if (files.length) {
        e.preventDefault();
        addFiles(files);
      }
    }
    document.addEventListener("paste", onPaste);
    return () => document.removeEventListener("paste", onPaste);
  }, []);

  function onScroll() {
    const el = messagesRef.current;
    if (!el) return;
    setShowScrollBtn(el.scrollHeight - el.scrollTop - el.clientHeight >= 60);
  }

  function toggleVoice() {
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SR) return;
    if (recording) {
      recognitionRef.current?.stop();
      return;
    }
    const rec = new SR();
    rec.continuous = false;
    rec.interimResults = false;
    rec.lang = "en-US";
    rec.onstart = () => setRecording(true);
    rec.onend = () => setRecording(false);
    rec.onerror = () => setRecording(false);
    rec.onresult = (e) => {
      const text = Array.from(e.results).map((r) => r[0].transcript).join("");
      setInput((v) => (v ? v + " " : "") + text);
    };
    recognitionRef.current = rec;
    rec.start();
  }

  const q = msgQuery.trim().toLowerCase();
  const hits = q ? messages.filter((m) => (m.text || "").toLowerCase().includes(q)) : [];

  return (
    <div id="chat-screen"
      onDragEnter={(e) => { if (e.dataTransfer.types.includes("Files")) { e.preventDefault(); dragCounterRef.current++; setDropActive(true); } }}
      onDragLeave={() => { dragCounterRef.current--; if (dragCounterRef.current <= 0) { dragCounterRef.current = 0; setDropActive(false); } }}
      onDragOver={(e) => { if (e.dataTransfer.types.includes("Files")) e.preventDefault(); }}
      onDrop={(e) => { e.preventDefault(); dragCounterRef.current = 0; setDropActive(false); const files = [...(e.dataTransfer.files || [])]; if (files.length) addFiles(files); }}
    >
      {dropActive && <div id="drop-overlay">Drop files to attach</div>}
      <div id="chat-header">
        <div className="chat-header-left">
          <button id="back-btn" onClick={handleBack}>&#8249; Back</button>
          <button className="icon-btn-sm" onClick={loadChat} title="Refresh">&#8635;</button>
          <button className="icon-btn-sm" onClick={() => setSearchOpen((v) => !v)} title="Search messages">
            <span className={"menu-arrow" + (searchOpen ? " open" : "")}>&#9660;</span>
          </button>
        </div>
        <div className="chat-header-center">
          <Avatar incognito={chat?.incognito} ownerId={chat?.ownerId} className="chat-header-avatar" />
          <span id="chat-title-el" onClick={rename}>{chat?.title || "..."}</span>
        </div>
        {canWrite && !chat?.incognito && (
          <button className="icon-btn-sm" onClick={rename} title="Rename">✏️</button>
        )}
      </div>

      <div className={"slide-bar msg-search-bar" + (searchOpen ? " open" : "")}>
        <button className="icon-btn-sm" title="Pinned files" onClick={() => setPinOpen(true)}>📌</button>
        <button className="icon-btn-sm" title="Export chat as ZIP" onClick={doExport} disabled={exporting}>📦</button>
        <button className="icon-btn-sm" title="Clean up old files" onClick={() => setSweepOpen(true)}>🧹</button>
        <div id="chat-search-wrap">
          <input placeholder="Search messages…" value={msgQuery} onChange={(e) => setMsgQuery(e.target.value)} />
          {msgQuery && <button className="search-clear" onClick={() => setMsgQuery("")}>✕</button>}
        </div>
        {hits.length > 1 && <span className="search-nav-count">{hits.length} hits</span>}
      </div>

      <div id="messages" ref={messagesRef} onScroll={onScroll}>
        {messages
          .filter((m) => !q || (m.text || "").toLowerCase().includes(q))
          .map((m) => (
          <div key={m.id} className={"bubble-wrap " + (m.role === "user" ? "me" : "them") + (q && m.text.toLowerCase().includes(q) ? " search-highlight" : "")}>
            {m.imgUrl ? (
              <div className="file-bubble">
                <img src={m.imgUrl} alt={m.imgLabel} style={{ maxWidth: "100%", borderRadius: 8, display: "block" }} />
                <span style={{ fontSize: 11, color: "var(--sub)", display: "block", marginTop: 4 }}>{m.imgLabel}</span>
              </div>
            ) : m.files && m.files.length && !m.text ? (
              <div className="file-bubble">
                {m.files.map((f, i) => {
                  const name = typeof f === "string" ? f : f.filename;
                  return (
                    <a key={i} href={`${API_BASE}/api/chats/${chatId}/files/${encodeURIComponent(name)}?token=${encodeURIComponent(token)}`}>
                      {fileIcon(name)} {name}
                    </a>
                  );
                })}
              </div>
            ) : (
              <>
                <div className="bubble">
                  {m.text}
                  {m.files && m.files.length > 0 && (
                    <div className="bubble-files">
                      {m.files.map((f, i) => {
                        const name = f.filename || f;
                        return (
                          <a key={i} className="file-attach-sent"
                            href={`${API_BASE}/api/chats/${chatId}/files/${encodeURIComponent(name)}?token=${encodeURIComponent(token)}`}>
                            {fileIcon(name)} {name}
                          </a>
                        );
                      })}
                    </div>
                  )}
                </div>
                <div className="bubble-meta">
                  <span className="bubble-ts">{timeAgo(m.ts)}</span>
                  {m.thinkMs > 0 && <span className="bubble-ts">◷ {fmtElapsed(m.thinkMs)}</span>}
                  {m.role !== "user" && m.text.trim() && (
                    <button
                      className="copy-btn"
                      onClick={(e) => {
                        navigator.clipboard.writeText(m.text);
                        const btn = e.currentTarget;
                        btn.textContent = "✓ Copied";
                        setTimeout(() => (btn.textContent = "⎘ Copy"), 1500);
                      }}
                    >
                      ⎘ Copy
                    </button>
                  )}
                </div>
                {m.askApproveReject && (
                  <div className="decision-btns">
                    <button className="decision-btn approve" onClick={handleApprove} disabled={thinking}>Approve</button>
                    <button className="decision-btn reject" onClick={handleReject} disabled={thinking}>Reject</button>
                  </div>
                )}
              </>
            )}
          </div>
        ))}
      </div>

      {thinking && (
        <div id="thinking">
          <span className="thinking-pulse">✶</span>
          <div id="thinking-status">
            <span className="think-verb">{thinkVerb}</span>
            <span className="think-meta">{elapsedLabel ? ` (${elapsedLabel})` : ""}</span>
          </div>
        </div>
      )}

      {showScrollBtn && (
        <button id="scroll-btn" onClick={() => { messagesRef.current.scrollTop = messagesRef.current.scrollHeight; setShowScrollBtn(false); }}>
          &#8595;
        </button>
      )}

      {!canWrite ? (
        <div id="readonly-bar"><span>👁 View only — this is not your chat</span></div>
      ) : (
        <div id="bottom-bar">
          {selectedFiles.length > 0 && (
            <div id="preview-bar">
              <div id="preview-chips">
                {selectedFiles.map((f, i) => (
                  <div key={i} className="file-chip">
                    <span>{fileIcon(f.name)}</span>
                    <span className="file-chip-name">{f.name}</span>
                    <button className="file-chip-rm" onClick={() => removeFile(i)}>✕</button>
                  </div>
                ))}
              </div>
              <button id="clear-file" onClick={() => setSelectedFiles([])}>&#x2715; Clear all</button>
            </div>
          )}
          <div id="input-row">
            <button id="attach-btn" onClick={() => fileInputRef.current.click()} title="Attach">📎</button>
            <div id="input-wrap">
              <textarea
                id="msg-input"
                rows={1}
                value={input}
                placeholder="Message..."
                onChange={(e) => {
                  setInput(e.target.value);
                  e.target.style.height = "auto";
                  e.target.style.height = Math.min(e.target.scrollHeight, 120) + "px";
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.shiftKey) {
                    e.preventDefault();
                    if (!thinking) doSend();
                  }
                }}
              />
              {(window.SpeechRecognition || window.webkitSpeechRecognition) && (
                <button id="mic-btn" className={recording ? "recording" : ""} onClick={toggleVoice}>&#127908;</button>
              )}
            </div>
            <button id="send-btn" disabled={!thinking && !input.trim() && !selectedFiles.length}
              onClick={() => (thinking ? stopRun() : doSend())}>
              {thinking ? "■" : "↑"}
            </button>
            <input ref={fileInputRef} type="file" accept="*/*" multiple
              style={{ display: "none" }}
              onChange={(e) => { addFiles(e.target.files); e.target.value = ""; }} />
          </div>
        </div>
      )}

      {pinOpen && <PinModal token={token} chatId={chatId} onClose={() => setPinOpen(false)} />}
      {sweepOpen && <SweepModal token={token} chatId={chatId} onClose={() => setSweepOpen(false)} />}
    </div>
  );
}

// ---------------- App ----------------
export default function App() {
  const [token, setToken] = useState(getStoredToken);
  const [view, setView] = useState({ screen: "list" });
  const socket = useSocket();

  function handleLogin(newToken) {
    localStorage.setItem("userToken", newToken);
    setToken(newToken);
  }

  if (!token) return <LoginScreen onLogin={handleLogin} />;

  const username = decodeUsername(token);
  const role = username === "admin" ? "admin" : "user";

  function logout() {
    localStorage.removeItem("userToken");
    setToken(null);
    setView({ screen: "list" });
  }

  if (view.screen === "chat") {
    return (
      <ChatScreen
        key={view.id}
        token={token}
        username={username}
        chatId={view.id}
        socket={socket}
        onBack={() => setView({ screen: "list" })}
        onDeleted={() => setView({ screen: "list" })}
      />
    );
  }

  if (view.screen === "tables") {
    return (
      <TablesScreen
        token={token}
        onOpen={(table) => setView({ screen: "tableDetail", table })}
        onBack={() => setView({ screen: "list" })}
      />
    );
  }

  if (view.screen === "tableDetail") {
    return (
      <TableDetailScreen
        key={view.table}
        token={token}
        tableName={view.table}
        onBack={() => setView({ screen: "tables" })}
      />
    );
  }

  return (
    <ChatListScreen
      token={token}
      username={username}
      role={role}
      socket={socket}
      onOpen={(id) => setView({ screen: "chat", id })}
      onLogout={logout}
      onOpenTables={() => setView({ screen: "tables" })}
    />
  );
}
