import { useEffect, useRef, useCallback, useState } from "react";

const WS_URL = (window.location.protocol === "https:" ? "wss://" : "ws://") + window.location.host + "/ws";

export function useSocket() {
  const wsRef = useRef(null);
  const listenersRef = useRef(new Set());
  const [connected, setConnected] = useState(false);

  useEffect(() => {
    let stopped = false;
    let ws;
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

  const send = useCallback((obj) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify(obj));
    }
  }, []);

  const subscribe = useCallback((fn) => {
    listenersRef.current.add(fn);
    return () => listenersRef.current.delete(fn);
  }, []);

  return { connected, send, subscribe };
}
