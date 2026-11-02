export const project = {
  id: "voicerooms",
  title: "VoiceRooms",
  titleEn: "VoiceRooms",
  kicker: "Разговор начинается в любом чате",
  kickerEn: "A conversation from any chat",
  summary:
    "Голосовые комнаты по приглашению. Создание из любого чата Telegram, приватный разговор, чат и показ экрана.",
  summaryEn:
    "Voice rooms by invitation. Create one from any Telegram chat, then talk, message and share your screen.",
  description:
    "Быстро собрать людей на разговор без регистрации на сайте и создания отдельной группы в Telegram.",
  descriptionEn:
    "Bring people into a conversation without website registration or creating a separate Telegram group.",
  cover: "https://voise.24projects.ru/portfolio-cover.svg",
  imageType: "interface",
  imageCaption: "Иллюстрация приглашения в VoiceRooms",
  imageCaptionEn: "VoiceRooms invitation illustration",
  tags: ["WebRTC", "Telegram", "React", "Node.js", "PostgreSQL"],
  members: ["andrey"],
  ownerId: "andrey",
  scope: "personal",
  status: "Тестовая версия",
  statusEn: "Beta",
  productUrl: "https://voise.24projects.ru/",
  sourceUrl: "https://github.com/Salatik-s/VoiseRooms",
  links: [
    { label: "Репозиторий", url: "https://github.com/Salatik-s/VoiseRooms" },
    { label: "Telegram-бот", url: "https://t.me/vidagram_bot" },
  ],
  story: [
    {
      id: "idea",
      title: "Задача",
      titleEn: "The idea",
      text: "Начать разговор из переписки: написать @vidagram_bot в любом чате и отправить готовое приглашение. Получателям не нужно регистрироваться на сайте.",
      textEn:
        "Start a call from a conversation: type @vidagram_bot in any chat and send the invitation. Participants do not need to register on the website.",
    },
    {
      id: "flow",
      title: "Как работает",
      titleEn: "How it works",
      text: "Бот создаёт комнату и предлагает приглашение. На сайте участники общаются голосом, переписываются, передают файлы и показывают экран. Создатель управляет участниками и завершает разговор.",
      textEn:
        "The bot creates a room and an invitation. On the website participants talk, message, share files and show their screens. The creator manages participants and ends the conversation.",
    },
    {
      id: "privacy",
      title: "Приватность без громких обещаний",
      titleEn: "Privacy without overpromising",
      text: "Приватные комнаты используют сквозное шифрование. Ключ передаётся в приглашении. Публичные комнаты защищены транспортным шифрованием; служебные данные обрабатывает сервер. Запись звонков в приложении не предусмотрена.",
      textEn:
        "Private rooms use end-to-end encryption, with the key included in the invitation. Public rooms use transport encryption; the server processes connection metadata. The application does not record calls.",
    },
    {
      id: "author",
      title: "Автор проекта",
      titleEn: "Project author",
      text: "Андрей Суховский самостоятельно разработал веб-интерфейс, серверную часть, Telegram-бота и развёртывание сервиса.",
      textEn:
        "Andrey Sukhovskiy independently developed the web interface, backend, Telegram bot and deployment.",
    },
  ],
  technical: [
    {
      id: "stack",
      title: "Архитектура",
      titleEn: "Architecture",
      text: "React и TypeScript на клиенте, Node.js и Fastify на сервере, PostgreSQL и Prisma для данных. LiveKit передаёт аудио, экран и сообщения по WebRTC.",
      textEn:
        "React and TypeScript on the client, Node.js and Fastify on the server, and PostgreSQL with Prisma for data. LiveKit carries audio, screen sharing and messaging over WebRTC.",
    },
    {
      id: "keys",
      title: "Защита разговора",
      titleEn: "Conversation security",
      text: "Клиенты шифруют приватные медиапотоки и чат. Файлы шифруются AES-GCM до отправки и удаляются через 5 минут. Права создателя проверяются сервером; данные Telegram проверяются по подписи и сроку действия.",
      textEn:
        "Clients encrypt private media and chat. Files are encrypted with AES-GCM before uploading and expire after five minutes. The server verifies creator permissions and checks Telegram signatures and freshness.",
    },
    {
      id: "ops",
      title: "Запуск на небольшом сервере",
      titleEn: "Running on a small server",
      text: "Сервисы разделены на контейнеры с ограничениями памяти. В базовой конфигурации — до 8 участников в комнате. Звонки проходят через собственный медиасервер; TURN для сложных сетей подключается отдельно.",
      textEn:
        "Services run in separate containers with memory limits. The baseline configuration allows up to eight participants per room. Calls use a self-hosted media server; TURN for restricted networks is configured separately.",
    },
  ],
};
export function addVoiceRooms(site, { cover = project.cover } = {}) {
  if (
    !site?.team?.some((p) => p.id === "andrey") ||
    !Array.isArray(site.projects)
  )
    throw Error("Portfolio has no Andrey profile");
  const matches = site.projects.filter(
    (p) =>
      p.id === project.id ||
      p.sourceUrl?.replace(/\/$/, "").toLowerCase() ===
        project.sourceUrl.toLowerCase(),
  );
  if (matches.length > 1)
    throw Error("Ambiguous VoiceRooms records; no changes made");
  if (matches.length) {
    const existing = matches[0];
    if (
      existing.ownerId !== "andrey" ||
      existing.members?.length !== 1 ||
      existing.members[0] !== "andrey"
    )
      throw Error("Existing project ownership differs");
    return { next: structuredClone(site), changed: false, id: existing.id };
  }
  const next = structuredClone(site);
  next.projects.push({ ...structuredClone(project), cover });
  next.revision = (site.revision || 0) + 1;
  return { next, changed: true, id: project.id };
}
