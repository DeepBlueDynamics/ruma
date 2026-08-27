type ClientLogLevel = 'info' | 'warn' | 'error';

type ClientLog = {
  level: ClientLogLevel;
  message: string;
  stack?: string;
  source: string;
  timestamp: string;
  url: string;
};

const endpoint = '/api/client-logs';
const queue: ClientLog[] = [];
let flushTimer: number | undefined;
let reloadScheduled = false;

function printable(value: unknown): string {
  if (value instanceof Error) return `${value.name}: ${value.message}`;
  if (typeof value === 'string') return value;
  try { return JSON.stringify(value); } catch { return String(value); }
}

function enqueue(level: ClientLogLevel, source: string, values: unknown[], stack?: string): void {
  queue.push({
    level,
    source,
    message: values.map(printable).join(' ').slice(0, 12_000),
    stack: stack?.slice(0, 24_000),
    timestamp: new Date().toISOString(),
    url: location.href,
  });
  if (queue.length > 100) queue.splice(0, queue.length - 100);
  if (flushTimer === undefined) flushTimer = window.setTimeout(flush, 180);
}

function flush(): void {
  flushTimer = undefined;
  if (!queue.length) return;
  const logs = queue.splice(0, 50);
  void fetch(endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ logs }),
    keepalive: true,
  }).catch(() => {
    queue.unshift(...logs);
    if (queue.length > 100) queue.length = 100;
  });
}

function currentBundle(): string | undefined {
  const script = [...document.scripts]
    .map(element => element.getAttribute('src') ?? '')
    .find(source => /\/assets\/index-[^/]+\.js(?:\?|$)/.test(source));
  return script?.split('?')[0];
}

async function reloadWhenBuildChanges(activeBundle: string): Promise<void> {
  try {
    const response = await fetch(`/?build-check=${Date.now()}`, { cache: 'no-store' });
    if (!response.ok) return;
    const html = await response.text();
    const nextBundle = html.match(/<script[^>]+src="([^"]*\/assets\/index-[^"?]+\.js)/)?.[1];
    if (!nextBundle || nextBundle === activeBundle || reloadScheduled) return;
    // Never tear down the command room while the operator is looking at it.
    // A hidden WebPane can safely adopt the new bundle, and persisted source
    // bindings reconnect before the operator returns.
    if (document.visibilityState !== 'hidden') return;
    reloadScheduled = true;
    enqueue('info', 'client.build-change', [`reload ${activeBundle} -> ${nextBundle}`]);
    flush();
    window.setTimeout(() => location.reload(), 80);
  } catch { /* The health/status UI reports server outages separately. */ }
}

export function installClientObservability(): void {
  const originalInfo = console.info.bind(console);
  const originalWarn = console.warn.bind(console);
  const originalError = console.error.bind(console);
  console.info = (...values: unknown[]) => {
    originalInfo(...values);
    enqueue('info', 'console.info', values);
  };
  console.warn = (...values: unknown[]) => {
    originalWarn(...values);
    enqueue('warn', 'console.warn', values);
  };
  console.error = (...values: unknown[]) => {
    originalError(...values);
    const error = values.find(value => value instanceof Error) as Error | undefined;
    enqueue('error', 'console.error', values, error?.stack);
  };
  addEventListener('error', event => {
    enqueue('error', 'window.error', [event.message], event.error instanceof Error ? event.error.stack : undefined);
  });
  addEventListener('unhandledrejection', event => {
    const reason = event.reason;
    enqueue('error', 'unhandledrejection', [reason], reason instanceof Error ? reason.stack : undefined);
  });
  addEventListener('pagehide', flush);

  const bundle = currentBundle();
  enqueue('info', 'client.boot', [`bundle=${bundle ?? 'vite-dev'}`, `viewport=${innerWidth}x${innerHeight}`, `dpr=${devicePixelRatio}`]);
  if (bundle) {
    const checkBuild = () => { void reloadWhenBuildChanges(bundle); };
    window.setInterval(checkBuild, 1500);
    // Hyperia may throttle a hidden WebPane. Visibility transitions give it a
    // prompt chance to adopt a pending build while it is safely off-screen.
    addEventListener('visibilitychange', checkBuild);
  }
}
