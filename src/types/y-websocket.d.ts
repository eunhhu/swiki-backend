declare module 'y-websocket/bin/utils' {
  // Minimal type declaration to satisfy TypeScript; the module provides setupWSConnection.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  export function setupWSConnection(ws: any, req: any, opts?: { pingTimeout?: number }): void;
}
