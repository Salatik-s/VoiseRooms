import test from "node:test";
import assert from "node:assert/strict";
import { friendlyError, readResponse, offlineMessage } from "../src/errors.ts";
test("network errors distinguish an offline device from an unavailable service", () => {
  assert.equal(
    friendlyError(new TypeError("Failed to fetch"), "general", false),
    offlineMessage,
  );
  assert.match(
    friendlyError(new TypeError("Failed to fetch"), "general", true),
    /связаться с сервером/,
  );
  assert.match(
    friendlyError(Error("could not establish pc connection"), "connect", true),
    /подключиться к разговору/,
  );
});
test("device and permission errors explain microphone recovery in Russian", () => {
  assert.match(
    friendlyError(
      Object.assign(Error("Permission denied"), { name: "NotAllowedError" }),
      "microphone",
    ),
    /Разрешите его в настройках браузера/,
  );
  assert.match(
    friendlyError(
      Object.assign(Error("Device missing"), { name: "NotFoundError" }),
      "microphone",
    ),
    /Микрофон не найден/,
  );
  assert.match(
    friendlyError(
      Object.assign(Error("Device busy"), { name: "NotReadableError" }),
      "microphone",
    ),
    /Закройте программы/,
  );
  assert.match(
    friendlyError(
      Object.assign(Error("The operation is not allowed"), {
        name: "NotAllowedError",
      }),
      "screen",
    ),
    /Выберите окно/,
  );
});
test("unknown library failures do not reach the UI and controlled Russian messages survive", () => {
  assert.equal(
    friendlyError(Error("Комната закрыта или срок приглашения истёк")),
    "Комната закрыта или срок приглашения истёк",
  );
  for (const e of [
    Error("JWT verification failed"),
    new SyntaxError("Unexpected token < in JSON"),
    Object.assign(Error("Unable to decrypt"), { name: "OperationError" }),
  ]) {
    const message = friendlyError(e, "file");
    assert.match(message, /[а-яё]/i);
    assert.doesNotMatch(
      message,
      /JWT|JSON|SyntaxError|OperationError|Unable|Unexpected/,
    );
  }
  assert.match(
    friendlyError(
      Object.assign(Error("Операция запрещена системой getUserMedia"), {
        name: "NotAllowedError",
      }),
      "microphone",
    ),
    /Нет доступа к микрофону/,
  );
});
test("HTTP and malformed proxy responses become actionable Russian messages", async () => {
  await assert.rejects(
    readResponse(
      new Response(JSON.stringify({ error: "Rate limit exceeded" }), {
        status: 429,
      }),
    ),
    /Подождите минуту/,
  );
  await assert.rejects(
    readResponse(new Response("<html>Bad gateway</html>", { status: 502 })),
    /Сервис временно недоступен/,
  );
  await assert.rejects(
    readResponse(
      new Response(JSON.stringify({ error: "Вход закрыт создателем" }), {
        status: 403,
      }),
    ),
    /Вход закрыт создателем/,
  );
  assert.deepEqual(
    await readResponse(
      new Response(JSON.stringify({ ok: true }), { status: 200 }),
    ),
    { ok: true },
  );
});
