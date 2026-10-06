import net from 'node:net';

/** Loopback only: engines we start must never be reachable from the LAN. */
export const LOOPBACK = '127.0.0.1';

/**
 * Asks the OS for a free TCP port on 127.0.0.1 (listen on 0, read it, close). There is an
 * unavoidable race until the engine binds it; the adapters detect "address in use" and report it.
 */
export function pickFreePort(host: string = LOOPBACK): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.once('error', reject);
    srv.listen({ host, port: 0, exclusive: true }, () => {
      const port = (srv.address() as net.AddressInfo).port;
      srv.close(() => resolve(port));
    });
  });
}

/** True when nothing listens on `port` (we can bind it ourselves). Any bind error counts as "busy". */
export function isPortFree(port: number, host: string = LOOPBACK): Promise<boolean> {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.unref();
    srv.once('error', () => resolve(false));
    srv.listen({ host, port, exclusive: true }, () => {
      srv.close(() => resolve(true));
    });
  });
}
