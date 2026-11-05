export type ErrorContext =
  "general" | "connect" | "microphone" | "screen" | "clipboard" | "file";
export const offlineMessage =
  "Нет подключения к интернету. Проверьте сеть и попробуйте ещё раз.";
const statusMessages: Record<number, string> = {
  400: "Не удалось выполнить действие. Обновите страницу и попробуйте ещё раз.",
  401: "Сессия истекла. Откройте комнату заново.",
  403: "У вас нет доступа к этому действию.",
  404: "Комната не найдена. Проверьте ссылку-приглашение.",
  410: "Комната закрыта или срок приглашения истёк.",
  413: "Файл или сообщение слишком большие. Уменьшите размер и попробуйте снова.",
  429: "Слишком много попыток. Подождите минуту и попробуйте снова.",
};
const unavailable = "Сервис временно недоступен. Попробуйте позже.";
export function friendlyError(
  error: unknown,
  context: ErrorContext = "general",
  online = typeof navigator === "undefined" || navigator.onLine !== false,
): string {
  const value =
    typeof error === "string"
      ? { message: error, name: "" }
      : error && typeof error === "object"
        ? (error as { message?: unknown; name?: unknown })
        : {};
  const message = typeof value.message === "string" ? value.message : "";
  const name = typeof value.name === "string" ? value.name : "";
  const network =
    /failed to fetch|fetch failed|network|load failed|connection|websocket|timed? ?out|timeout|signal|pc connection|ICE failed/i.test(
      message,
    ) || name === "TimeoutError";
  if (!online && (network || context === "connect")) return offlineMessage;
  // Keep our explanatory Russian API and validation messages, never library diagnostics.
  if (
    (name === "" || name === "Error") &&
    /[а-яё]/i.test(message) &&
    !/TypeError|SyntaxError|ReferenceError|OperationError|Exception|undefined|null|stack trace|failed|cannot|could not/i.test(
      message,
    )
  )
    return message;
  if (context === "microphone") {
    if (name === "NotFoundError" || name === "DevicesNotFoundError")
      return "Микрофон не найден. Подключите его или оставайтесь слушателем.";
    if (name === "NotReadableError" || name === "TrackStartError")
      return "Не удалось включить микрофон. Закройте программы, которые могут его использовать, и попробуйте снова.";
    if (
      name === "NotAllowedError" ||
      name === "PermissionDeniedError" ||
      /permission|denied/i.test(message)
    )
      return "Нет доступа к микрофону. Разрешите его в настройках браузера. Пока можно слушать.";
    return "Не удалось включить микрофон. Проверьте устройство и разрешение в браузере. Пока можно слушать.";
  }
  if (context === "screen" && /NotAllowedError|AbortError/.test(name))
    return "Показ экрана не начат. Выберите окно и разрешите доступ.";
  if (context === "clipboard")
    return "Не удалось скопировать приглашение. Скопируйте ссылку из адресной строки.";
  if (
    context === "file" &&
    /OperationError|DataError|InvalidAccessError/.test(name)
  )
    return "Не удалось открыть файл. Проверьте приглашение и попросите отправить файл заново.";
  if (context === "connect")
    return "Не удалось подключиться к разговору. Проверьте интернет и попробуйте ещё раз.";
  if (network)
    return "Не удалось связаться с сервером. Проверьте интернет и попробуйте ещё раз.";
  if (name === "NotAllowedError")
    return "Браузер не разрешил это действие. Проверьте разрешения и попробуйте снова.";
  if (name === "SyntaxError") return unavailable;
  return "Не удалось выполнить действие. Попробуйте ещё раз. Если ошибка повторяется, обновите страницу.";
}
export async function readResponse(response: Response) {
  let data;
  try {
    data = await response.json();
  } catch {
    throw Error(statusMessages[response.status] || unavailable);
  }
  if (!response.ok)
    throw Error(
      typeof data.error === "string" && /[а-яё]/i.test(data.error)
        ? friendlyError(data.error)
        : statusMessages[response.status] || unavailable,
    );
  return data;
}
