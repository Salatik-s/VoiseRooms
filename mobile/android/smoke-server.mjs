import http from "node:http";
import { mkdir, writeFile } from "node:fs/promises";

let failures = 0;

const screenshotNames = new Set([
  "android-call-phone",
  "android-chat-phone",
  "android-error-phone",
]);
const server = http.createServer(async (req, res) => {
  if (
    req.method === "POST" &&
    req.url?.startsWith("/__native_test_screenshot")
  ) {
    const name = new URL(req.url, "http://127.0.0.1:5200").searchParams.get(
      "name",
    );
    if (!screenshotNames.has(name)) {
      res.writeHead(400);
      res.end();
      return;
    }
    const chunks = [];
    let length = 0;
    for await (const chunk of req) {
      length += chunk.length;
      if (length > 5000000) {
        res.writeHead(413);
        res.end();
        return;
      }
      chunks.push(chunk);
    }
    const directory = new URL("./phone-screenshots/", import.meta.url);
    await mkdir(directory, { recursive: true });
    await writeFile(new URL(name + ".png", directory), Buffer.concat(chunks));
    res.writeHead(201);
    res.end("saved");
    return;
  }

  if (req.method === "POST" && req.url === "/__native_test_recover") {
    failures = 1;
    res.writeHead(200);
    res.end("recovered");
    return;
  }

  if (req.url?.startsWith("/__native_test_failure") && failures === 0) {
    res.writeHead(503, {
      "content-type": "text/plain; charset=utf-8",
      "cache-control": "no-store",
    });
    res.end("Проверка восстановления");
    return;
  }

  const proxy = http.request(
    {
      hostname: "127.0.0.1",
      port: 5199,
      path: req.url,
      method: req.method,
      headers: { ...req.headers, host: "127.0.0.1:5199" },
    },
    (upstream) => {
      res.writeHead(upstream.statusCode || 502, upstream.headers);
      upstream.pipe(res);
    },
  );
  proxy.on("error", () => {
    res.writeHead(502);
    res.end("Preview unavailable");
  });
  req.pipe(proxy);
});
server.listen(5200, "0.0.0.0");
