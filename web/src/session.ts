/**
 * Connection persistence. The bearer token lives in sessionStorage only: it
 * survives reloads within the same tab (a same-tab refresh keeps the view) and
 * dies with the tab session — closing the tab loses it and reopening requires
 * pasting the token again. It is never written to localStorage or logged.
 */
export type Connection = { base: string; token: string };

const BASE_KEY = "loom.workbench.base";
const TOKEN_KEY = "loom.workbench.token";

export function readConnection(): Connection | null {
  const base = sessionStorage.getItem(BASE_KEY);
  const token = sessionStorage.getItem(TOKEN_KEY);
  return base && token ? { base, token } : null;
}

export function saveConnection(connection: Connection): void {
  sessionStorage.setItem(BASE_KEY, connection.base);
  sessionStorage.setItem(TOKEN_KEY, connection.token);
}

export function clearConnection(): void {
  sessionStorage.removeItem(BASE_KEY);
  sessionStorage.removeItem(TOKEN_KEY);
}
