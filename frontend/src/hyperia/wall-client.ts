import type { WallMessage } from './protocol';

export class HyperiaWallClient {
  private socket?: WebSocket;

  constructor(
    private readonly url: URL,
    private readonly onMessage: (message: WallMessage) => void,
  ) {}

  connect(): void {
    this.socket = new WebSocket(this.url);
    this.socket.addEventListener('message', (event) => {
      if (typeof event.data !== 'string') return;
      const message = JSON.parse(event.data) as WallMessage;
      if (message.t === 'ping') this.send({ t: 'pong' });
      if (message.t === 'resync') this.send({ t: 'resync' });
      this.onMessage(message);
    });
  }

  setFps(fps: number): void {
    this.send({ t: 'fps', fps: Math.max(1, Math.min(60, fps)) });
  }

  close(): void { this.socket?.close(); }

  private send(value: object): void {
    if (this.socket?.readyState === WebSocket.OPEN) this.socket.send(JSON.stringify(value));
  }
}

