/**
 * Node-side shims for the browser globals the app modules touch at import time.
 *
 * `StateStoreV3.loadAndMigrate()` reads `localStorage` outside its try/catch
 * (store.ts:196, store.ts:203), so importing the store under Node throws
 * ReferenceError without this. The shim is deliberately dumb — an in-memory Map
 * with the Storage surface the store actually uses.
 */
class MemoryStorage implements Storage {
  private map = new Map<string, string>();

  get length(): number {
    return this.map.size;
  }

  clear(): void {
    this.map.clear();
  }

  getItem(key: string): string | null {
    return this.map.has(key) ? (this.map.get(key) as string) : null;
  }

  key(index: number): string | null {
    return Array.from(this.map.keys())[index] ?? null;
  }

  removeItem(key: string): void {
    this.map.delete(key);
  }

  setItem(key: string, value: string): void {
    this.map.set(key, String(value));
  }

  [name: string]: unknown;
}

if (typeof globalThis.localStorage === 'undefined') {
  Object.defineProperty(globalThis, 'localStorage', {
    value: new MemoryStorage(),
    configurable: true,
  });
}
