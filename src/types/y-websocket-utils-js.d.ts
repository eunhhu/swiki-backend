declare module 'y-websocket/bin/utils.js' {
  // Minimal type declaration for ESM path
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  export function setupWSConnection(ws: any, req: any, opts?: { pingTimeout?: number }): void;
}
