export type StreamSession = {
  generation: number;
  socket?: WebSocket;
  live: boolean;
  powered: boolean;
};

export type StreamContext = { generation: number; socket: WebSocket };

export type StreamHandlers = {
  onText?: (message: Record<string, unknown>, ctx: StreamContext) => void;
  onBinary?: (data: ArrayBuffer | Blob, ctx: StreamContext) => void;
  onClose?: (ctx: StreamContext) => void;
  onError?: (ctx: StreamContext) => void;
};

export function hyperiaWsUrl(path: string): string {
  const protocol = typeof location !== 'undefined' && location.protocol === 'https:' ? 'wss:' : 'ws:';
  const host = typeof location !== 'undefined' ? location.hostname : 'localhost';
  const normalized = path.startsWith('/') ? path : `/${path}`;
  return `${protocol}//${host}:9800${normalized}`;
}

/** Already assigned to this pane and the socket is still connecting or open. */
export function sessionAlreadyStreaming(session: { paneId: string; socket?: WebSocket }, paneId: string): boolean {
  return session.paneId === paneId && !!session.socket && session.socket.readyState <= WebSocket.OPEN;
}

/**
 * One generation + socket lifecycle for PTY and web-pixel streams.
 * Callers must set paneId / source before opening. Ping/pong is handled here.
 */
export function openContentSocket(session: StreamSession, url: string, handlers: StreamHandlers): StreamContext {
  const generation = ++session.generation;
  session.socket?.close();
  session.live = false;
  const socket = new WebSocket(url);
  session.socket = socket;
  socket.binaryType = 'arraybuffer';
  const ctx: StreamContext = { generation, socket };
  socket.addEventListener('message', event => {
    if (generation !== session.generation || !session.powered) return;
    if (typeof event.data === 'string') {
      const message = JSON.parse(event.data) as Record<string, unknown>;
      if (message.t === 'ping') socket.send(JSON.stringify({ t: 'pong' }));
      handlers.onText?.(message, ctx);
      return;
    }
    handlers.onBinary?.(event.data as ArrayBuffer | Blob, ctx);
  });
  socket.addEventListener('close', () => {
    if (generation === session.generation && session.powered) handlers.onClose?.(ctx);
  });
  socket.addEventListener('error', () => {
    if (generation === session.generation) handlers.onError?.(ctx);
  });
  return ctx;
}
