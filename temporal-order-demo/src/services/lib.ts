import http from 'http';

type Handler = (body: any) => Promise<any> | any;

// Minimal JSON HTTP service: POST routes + a GET /state route. No framework.
export function serve(name: string, port: number, routes: Record<string, Handler>, state: () => any) {
  const server = http.createServer(async (req, res) => {
    const send = (code: number, obj: any) => {
      res.writeHead(code, { 'content-type': 'application/json' });
      res.end(JSON.stringify(obj));
    };
    if (req.method === 'GET' && req.url === '/state') return send(200, state());

    const route = routes[req.url ?? ''];
    if (req.method === 'POST' && route) {
      let raw = '';
      req.on('data', (c) => (raw += c));
      req.on('end', async () => {
        try {
          const body = raw ? JSON.parse(raw) : {};
          const result = await route({ ...body, headers: req.headers });
          send(200, result ?? { ok: true });
        } catch (err: any) {
          send(err.status ?? 500, { error: err.message ?? String(err) });
        }
      });
      return;
    }
    send(404, { error: 'not found' });
  });
  server.listen(port, () => console.log(`[${name}] listening on :${port}`));
  return server;
}

export function log(name: string, msg: string) {
  console.log(`[${name}] ${new Date().toISOString().slice(11, 23)} ${msg}`);
}

// Throw an error the http layer turns into a given status code.
export function httpError(status: number, message: string) {
  const e: any = new Error(message);
  e.status = status;
  return e;
}
