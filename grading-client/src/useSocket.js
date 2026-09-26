// In plain English: this file manages the ONE live connection to the
// server that the whole app shares, so replies can stream in instantly.
// It also automatically reconnects if the connection drops, so a brief
// network hiccup doesn't require refreshing the page.
import { useEffect, useRef, useCallback, useState } from "react";

// Uses a secure connection (wss) when the page itself is secure (https),
// and a plain one otherwise - matches whatever the page is already using.
const WS_URL = (window.location.protocol === "https:" ? "wss://" : "ws://") + window.location.host + "/ws";

// In plain English: sets up the live connection once, and hands the rest
// of the app three things - "are we connected right now," "send this,"
// and "let me know whenever a new message comes in."
export function useSocket() {
  const wsRef = useRef(null);
  const listenersRef = useRef(new Set());
  const [connected, setConnected] = useState(false);

  useEffect(() => {
    let stopped = false;
    let ws;
    // In plain English: opens the connection, and if it ever closes
    // unexpectedly, waits 2 seconds and tries again automatically.
    function connect() {
      ws = new WebSocket(WS_URL);
      wsRef.current = ws;
      ws.onopen = () => setConnected(true);
      ws.onclose = () => {
        setConnected(false);
        if (!stopped) setTimeout(connect, 2000);
      };
      ws.onerror = () => {};
      ws.onmessage = (e) => {
        let msg;
        try {
          msg = JSON.parse(e.data);
        } catch {
          return;
        }
        listenersRef.current.forEach((fn) => fn(msg));
      };
    }
    connect();
    return () => {
      stopped = true;
      wsRef.current?.close();
    };
  }, []);

  // In plain English: sends something to the server, but only if the
  // connection is actually open right now (otherwise it's silently skipped
  // rather than crashing).
  const send = useCallback((obj) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify(obj));
    }
  }, []);

  // In plain English: lets a screen say "call this function every time a
  // new message arrives," and gives back a way to stop listening later.
  const subscribe = useCallback((fn) => {
    listenersRef.current.add(fn);
    return () => listenersRef.current.delete(fn);
  }, []);

  return { connected, send, subscribe };
}
