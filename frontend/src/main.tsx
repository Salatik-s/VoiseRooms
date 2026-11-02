import React from "react";
import ReactDOM from "react-dom/client";

async function bootstrap() {
  const hash = new URLSearchParams(location.hash.slice(1));
  const room = new URLSearchParams(location.search).get("room"),
    key = hash.get("key");
  if (room && key && /^[\w-]{43}$/.test(key))
    sessionStorage.setItem("vr-key-" + room, key);
  const telegramContext =
    hash.has("tgWebAppData") ||
    hash.has("tgWebAppVersion") ||
    sessionStorage.getItem("vr-telegram-context") === "yes";
  // Ordinary website visitors do not load Telegram JavaScript or send requests to Telegram.
  if (telegramContext) {
    sessionStorage.setItem("vr-telegram-context", "yes");
    try {
      await new Promise<void>((resolve, reject) => {
        const script = document.createElement("script"),
          timer = setTimeout(() => reject(Error("timeout")), 12000);
        script.src = "https://telegram.org/js/telegram-web-app.js?62";
        script.onload = () => {
          clearTimeout(timer);
          resolve();
        };
        script.onerror = () => {
          clearTimeout(timer);
          reject(Error("sdk"));
        };
        document.head.append(script);
      });
    } catch {
      document.getElementById("root")!.textContent =
        "Не удалось загрузить Telegram. Закройте Mini App и откройте его заново.";
      return;
    }
  }
  const { default: App } = await import("./App");
  ReactDOM.createRoot(document.getElementById("root")!).render(
    <React.StrictMode>
      <App />
    </React.StrictMode>,
  );
}
bootstrap().catch(() => {
  document.getElementById("root")!.textContent =
    "Не удалось открыть VoiceRooms. Обновите страницу.";
});
