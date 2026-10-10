import http from "node:http";

export function startMockProvider(routes) {
  const calls = [];
  const server = http.createServer((request, response) => {
    const url = new URL(request.url, "http://localhost");
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => {
      const body = Buffer.concat(chunks).toString("utf8");
      calls.push({ method: request.method, path: url.pathname, headers: request.headers, body });
      const route = routes[`${request.method} ${url.pathname}`] ?? routes[url.pathname];
      if (!route) {
        response.writeHead(404, { "Content-Type": "application/json" });
        response.end(JSON.stringify({ error: `no route for ${url.pathname}` }));
        return;
      }
      const result = typeof route === "function" ? route({ request, url, body }) : route;
      if (result?.raw !== undefined) {
        response.writeHead(result.status ?? 200, { "Content-Type": result.contentType ?? "application/json" });
        response.end(result.raw);
        return;
      }
      response.writeHead(result?.status ?? 200, { "Content-Type": "application/json" });
      response.end(JSON.stringify(result?.body ?? result ?? {}));
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      resolve({
        baseUrl: `http://127.0.0.1:${port}`,
        calls,
        close: () => new Promise((done) => server.close(done)),
      });
    });
  });
}
