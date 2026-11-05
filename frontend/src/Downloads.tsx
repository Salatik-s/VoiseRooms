import { useEffect, useState } from "react";
import {
  AudioLines,
  ArrowLeft,
  Download,
  Smartphone,
  ArrowUpRight,
  Check,
} from "lucide-react";
import { LegalLinks } from "./Legal";
const files = [
  {
    id: "android",
    label: "Android",
    extension: "APK",
    path: "/downloads/VoiceRooms-1.2.0.apk",
    hint: "Установка напрямую на телефон",
  },
  {
    id: "ios",
    label: "iPhone",
    extension: "IPA",
    path: "/downloads/VoiceRooms-1.2.0.ipa",
    hint: "Установка с компьютера через Sideloadly",
  },
];
export default function Downloads() {
  const [available, setAvailable] = useState<
    Record<string, boolean | undefined>
  >({});
  useEffect(() => {
    let active = true;
    Promise.all(
      files.map(async (file) => {
        try {
          const r = await fetch(file.path, {
            method: "HEAD",
            cache: "no-store",
          });
          const type = r.headers.get("content-type") || "";
          const size = Number(r.headers.get("content-length") || 0);
          if (active)
            setAvailable((v) => ({
              ...v,
              [file.id]: r.ok && !type.includes("text/html") && size > 0,
            }));
        } catch {
          if (active) setAvailable((v) => ({ ...v, [file.id]: false }));
        }
      }),
    );
    return () => {
      active = false;
    };
  }, []);
  return (
    <div className="download-page">
      <header className="lobby-topbar">
        <a href="/" className="wordmark">
          <AudioLines size={23} />
          VoiceRooms
        </a>
        <a href="/" className="telegram-link">
          <ArrowLeft size={17} />К комнатам
        </a>
      </header>
      <main className="download-content">
        <div className="download-heading">
          <span className="download-symbol">
            <Smartphone size={31} />
          </span>
          <h1>VoiceRooms на телефоне</h1>
          <p>Создавайте комнаты и общайтесь по приглашению.</p>
        </div>
        <div className="download-options">
          {files.map((file) => (
            <article className="download-option" key={file.id}>
              <div className="download-option-title">
                <h2>{file.label}</h2>
                <span>{file.extension} · 1.2.0</span>
              </div>
              <p>{file.hint}</p>
              {available[file.id] ? (
                <a
                  className="btn btn-primary download-action"
                  href={file.path}
                  download
                >
                  <Download size={19} />
                  Скачать {file.extension}
                </a>
              ) : (
                <button
                  className="btn download-action download-unavailable"
                  disabled
                >
                  {available[file.id] === undefined
                    ? "Проверяем файл…"
                    : "Файл пока недоступен"}
                </button>
              )}
            </article>
          ))}
        </div>
        <section className="install-guide">
          <h2>Как установить на Android</h2>
          <ol>
            <li>Скачайте APK на телефон и откройте файл.</li>
            <li>
              Если Android попросит, разрешите установку из браузера или
              файлового приложения.
            </li>
            <li>
              Установите VoiceRooms. Доступ к микрофону можно разрешить при
              первом разговоре.
            </li>
          </ol>
        </section>
        <section className="install-guide" id="install-iphone">
          <h2>Как установить на iPhone</h2>
          <p>
            Для IPA понадобится iPhone с iOS 17 или новее, компьютер с Windows
            или macOS, кабель и ваш Apple ID. Файл скачивается без подписи;
            Sideloadly подпишет его под ваш аккаунт.
          </p>
          <ol>
            <li>
              Установите{" "}
              <a href="https://sideloadly.io/" target="_blank" rel="noreferrer">
                Sideloadly <ArrowUpRight size={13} />
              </a>{" "}
              на компьютер и скачайте IPA с этой страницы.
            </li>
            <li>
              Подключите iPhone кабелем, разблокируйте его и подтвердите доверие
              компьютеру.
            </li>
            <li>
              Откройте IPA в Sideloadly, выберите iPhone, укажите свой Apple ID
              и нажмите Start. Вводите пароль только в программе установки, сайт
              VoiceRooms его не запрашивает.
            </li>
            <li>
              Если iPhone попросит, включите режим разработчика в «Настройки →
              Конфиденциальность и безопасность». Разрешите запуск приложения в
              «Настройки → Основные → VPN и управление устройством».
            </li>
          </ol>
          <div className="installation-note">
            <Check size={19} />
            <p>
              С бесплатным Apple ID подпись действует 7 дней. После этого её
              нужно обновить через Sideloadly; можно настроить автоматическое
              обновление.
            </p>
          </div>
          <p className="installation-source">
            Подробнее:{" "}
            <a
              href="https://sideloadly.io/faq"
              target="_blank"
              rel="noreferrer"
            >
              инструкция Sideloadly
            </a>{" "}
            и{" "}
            <a
              href="https://developer.apple.com/help/account/basics/about-your-developer-account/"
              target="_blank"
              rel="noreferrer"
            >
              правила Apple
            </a>
            .
          </p>
        </section>
        <a className="text-link download-browser-link" href="/">
          Продолжить в браузере <ArrowUpRight size={16} />
        </a>
      </main>
      <LegalLinks />
    </div>
  );
}
