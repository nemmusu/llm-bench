import net from 'node:net';
import { describe, expect, it } from 'vitest';
import { LOOPBACK, isPortFree, pickFreePort } from '../../../../src/core/process/ports';

describe('ports', () => {
  it('picks a free loopback port that is then actually free', async () => {
    const port = await pickFreePort();
    expect(port).toBeGreaterThan(0);
    expect(await isPortFree(port)).toBe(true);
  });

  it('reports a port in use as busy', async () => {
    const srv = net.createServer();
    await new Promise<void>((r) => srv.listen(0, LOOPBACK, r));
    const port = (srv.address() as net.AddressInfo).port;
    try {
      expect(await isPortFree(port, LOOPBACK)).toBe(false);
    } finally {
      await new Promise((r) => srv.close(r));
    }
  });

  it('rejects when the host cannot be bound', async () => {
    await expect(pickFreePort('256.1.1.1')).rejects.toThrow();
  });
});
