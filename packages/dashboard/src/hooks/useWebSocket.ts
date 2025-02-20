import { useEffect, useRef, useState } from 'react';

interface WebSocketMessage {
  data: string;
  type: string;
  timestamp: number;
}

export const useWebSocket = (url: string) => {
  const [lastMessage, setLastMessage] = useState<WebSocketMessage | null>(null);
  const [readyState, setReadyState] = useState<number>(WebSocket.CONNECTING);
  const ws = useRef<WebSocket | null>(null);

  useEffect(() => {
    if (!url) return;

    ws.current = new WebSocket(url);

    ws.current.onopen = () => {
      console.log('WebSocket connected');
      setReadyState(WebSocket.OPEN);
    };

    ws.current.onclose = () => {
      console.log('WebSocket disconnected');
      setReadyState(WebSocket.CLOSED);
    };

    ws.current.onmessage = (event) => {
      const message: WebSocketMessage = {
        data: event.data,
        type: event.type,
        timestamp: Date.now(),
      };
      setLastMessage(message);
    };

    return () => {
      if (ws.current) {
        ws.current.close();
      }
    };
  }, [url]);

  return {
    lastMessage,
    readyState,
  };
}; 