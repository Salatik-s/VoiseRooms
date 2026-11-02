"""VoiceRooms bot. Inline invitations never contain media access tokens."""

import asyncio
import hashlib
import html
import json
import logging
import os
import re
import secrets
import sys
import time
from collections import OrderedDict
from urllib.parse import parse_qs, quote, urlparse

import aiohttp
from aiogram import Bot, Dispatcher, F, types
from aiogram.client.default import DefaultBotProperties
from aiogram.client.session.aiohttp import AiohttpSession
from aiogram.filters import Command, CommandStart
from aiogram.types import (
    InlineKeyboardButton as Button,
)
from aiogram.types import (
    InlineKeyboardMarkup as Keyboard,
)

BACKEND_URL = os.getenv("BACKEND_URL", "http://backend:3000").rstrip("/")
SITE_URL = os.getenv(
    "APP_PUBLIC_URL", "https://" + os.getenv("DOMAIN", "voise.24projects.ru")
).rstrip("/")
OWNER = int(os.getenv("OWNER_TG_ID", "0"))
dp = Dispatcher()
log = logging.getLogger("voicerooms.bot")
waiting = set()
inline_cache = OrderedDict()
inline_locks = {}
WELCOME = (
    "<b>VoiceRooms</b>\nГолосовые комнаты по приглашению.\n\n"
    "Создайте комнату и отправьте ссылку друзьям. Можно общаться голосом, "
    "переписываться и показывать экран.\n\n"
    "Чтобы пригласить людей прямо из любого чата, наберите "
    "<code>@vidagram_bot</code> и отправьте предложенную карточку.\n\n"
    "<blockquote>Приватные комнаты используют сквозное шифрование. "
    "Ключ находится в приглашении — передавайте его только участникам.</blockquote>"
)
PRIVACY = (
    "<b>Как устроена приватность</b>\n\n"
    "В приватных комнатах аудио, экран и чат защищены сквозным шифрованием. "
    "Ключ передаётся в ссылке. Публичные комнаты защищены TLS, без E2EE.\n\n"
    "Сервер обрабатывает служебные данные соединений и идентификатор Telegram "
    "для управления комнатами. Telegram видит взаимодействие с ботом. "
    "Это не сервис абсолютной анонимности.\n\n"
    "Запись звонков не ведётся. Зашифрованные файлы удаляются через 5 минут. "
    "Сообщения чата не сохраняются в базе сервера."
)


def menu():
    return Keyboard(
        inline_keyboard=[
            [Button(text="Создать комнату", callback_data="create", style="primary")],
            [
                Button(text="Присоединиться", callback_data="join"),
                Button(text="Открыть сайт", url=SITE_URL),
            ],
            [Button(text="Пригласить в любом чате", switch_inline_query="")],
            [Button(text="О приватности", callback_data="privacy")],
        ]
    )


def invitation(code, key):
    if not re.fullmatch(r"[A-Z2-9]{8}", code) or not re.fullmatch(r"[\w-]{43}", key):
        raise ValueError("Invalid invitation")
    return f"{SITE_URL}/?room={quote(code)}#key={key}"


def room_buttons(code, key, username="vidagram_bot", private_chat=False):
    deep_link = f"https://t.me/{username}?start=room_{code}_{key}"
    rows = [
        [
            Button(
                text="Войти в комнату",
                web_app=types.WebAppInfo(url=invitation(code, key)),
                style="primary",
            )
            if private_chat
            else Button(text="Войти через Telegram", url=deep_link, style="primary")
        ],
        [Button(text="Открыть в браузере", url=invitation(code, key))],
    ]
    if private_chat:
        rows.append(
            [
                Button(
                    text="Скопировать приглашение",
                    copy_text=types.CopyTextButton(text=invitation(code, key)),
                )
            ]
        )
    return Keyboard(inline_keyboard=rows)


async def request(user_id, path, body=None):
    headers = {
        "X-Internal-Key": os.environ["INTERNAL_KEY"],
        "X-User-Data": json.dumps({"id": user_id}),
    }
    timeout = aiohttp.ClientTimeout(total=15)
    async with aiohttp.ClientSession(timeout=timeout, headers=headers) as client:
        async with client.request(
            "POST" if body is not None else "GET",
            BACKEND_URL + "/api" + path,
            json=body,
        ) as response:
            data = await response.json()
            if response.status >= 400:
                raise RuntimeError(data.get("error", "Сервис временно недоступен"))
            return data


async def new_room(user_id, name=None):
    key = secrets.token_urlsafe(32)
    proof = hashlib.sha256(("VoiceRooms admission v1:" + key).encode()).hexdigest()
    access_hash = hashlib.sha256(proof.encode()).hexdigest()
    data = await request(
        user_id,
        "/room/create",
        {"name": name or "Разговор по приглашению", "accessHash": access_hash},
    )
    return data["code"], key


async def send_room(message, code, key):
    await message.answer(
        "<b>Комната готова</b>\n\nОтправьте приглашение участникам. "
        "Микрофон включается после входа на сайт.\n"
        "<blockquote>Ссылка содержит ключ шифрования. Не публикуйте её в открытом доступе.</blockquote>",
        reply_markup=room_buttons(code, key, private_chat=True),
        link_preview_options=types.LinkPreviewOptions(is_disabled=True),
    )


@dp.message(CommandStart())
async def start(message: types.Message):
    if message.chat.type != "private":
        await message.answer(
            "Создайте приглашение прямо здесь: наберите @vidagram_bot в поле сообщения."
        )
        return
    payload = (message.text or "").partition(" ")[2]
    match = re.fullmatch(r"room_([A-Z2-9]{8})_([\w-]{43})", payload)
    if match:
        try:
            await request(message.from_user.id, "/room/join", {"code": match[1]})
            await send_room(message, match[1], match[2])
        except Exception:
            await message.answer(
                "Приглашение недоступно. Попросите создателя отправить новое.",
                reply_markup=menu(),
            )
        return
    await message.answer(WELCOME, reply_markup=menu())


@dp.message(Command("help"))
async def help_command(message: types.Message):
    await message.answer(
        "<b>Как начать разговор</b>\n\n"
        "1. Создайте комнату.\n2. Отправьте приглашение.\n3. Войдите и разрешите микрофон.\n\n"
        "В любом чате наберите @vidagram_bot — создавать отдельную группу Telegram не нужно.\n\n"
        "Показ экрана зависит от браузера. Надёжнее всего использовать актуальный браузер на компьютере.",
        reply_markup=menu(),
    )


@dp.message(Command("cancel"))
async def cancel(message: types.Message):
    waiting.discard(message.from_user.id)
    await message.answer("Ввод отменён.", reply_markup=menu())


@dp.message(Command("stats"))
async def stats(message: types.Message):
    if message.chat.type != "private" or message.from_user.id != OWNER:
        return
    try:
        data = await request(message.from_user.id, "/admin/stats")
        await message.answer(
            f"<b>Состояние VoiceRooms</b>\nАктивных комнат: {data['active_rooms']}\nЗаписей пользователей: {data['total_users']}"
        )
    except Exception:
        await message.answer("Статистика временно недоступна.")


@dp.message(Command("admin"))
async def admin_command(message: types.Message):
    if message.chat.type != "private" or message.from_user.id != OWNER:
        await message.answer("Команда доступна владельцу в личном чате с ботом.")
        return
    try:
        data = await request(message.from_user.id, "/admin/pair/code", {})
        await message.answer(
            "<b>Вход в панель управления</b>\n\nОдноразовый код: "
            f"<code>{html.escape(data['code'])}</code>\n\n"
            "Введите его в приложении администратора или на сайте. "
            "Действует 5 минут. Никому не передавайте код.",
            protect_content=True,
            reply_markup=Keyboard(
                inline_keyboard=[
                    [
                        Button(
                            text="Скопировать код",
                            copy_text=types.CopyTextButton(text=data["code"]),
                        )
                    ]
                ]
            ),
        )
    except Exception:
        await message.answer(
            "Не удалось получить код. Проверьте доступность сервиса и повторите /admin."
        )


@dp.callback_query(F.data.in_({"create", "join", "privacy"}))
async def callback(query: types.CallbackQuery):
    await query.answer()
    if (
        not isinstance(query.message, types.Message)
        or query.message.chat.type != "private"
    ):
        return
    if query.data == "privacy":
        await query.message.answer(PRIVACY, reply_markup=menu())
    elif query.data == "join":
        waiting.add(query.from_user.id)
        await query.message.answer(
            "Пришлите полную ссылку-приглашение. Для отмены — /cancel."
        )
    else:
        waiting.discard(query.from_user.id)
        try:
            code, key = await new_room(query.from_user.id)
            await send_room(query.message, code, key)
        except Exception:
            await query.message.answer(
                "Комната не создана. Попробуйте немного позже.", reply_markup=menu()
            )


@dp.inline_query()
async def inline(query: types.InlineQuery):
    """Reuse a suggestion for 60 seconds instead of creating rooms on every keystroke."""
    uid = query.from_user.id
    lock = inline_locks.setdefault(uid, asyncio.Lock())
    try:
        async with lock:
            now = time.monotonic()
            for k, value in list(inline_cache.items()):
                if value[0] < now:
                    inline_cache.pop(k, None)
                    if k != uid:
                        inline_locks.pop(k, None)
            cached = inline_cache.get(uid)
            if not cached:
                code, key = await new_room(uid)
                cached = (now + 60, code, key)
                inline_cache[uid] = cached
                while len(inline_cache) > 2000:
                    old, _ = inline_cache.popitem(last=False)
                    if old != uid:
                        inline_locks.pop(old, None)
            _, code, key = cached
        result = types.InlineQueryResultArticle(
            id=code,
            title="Создать голосовую комнату",
            description="Отправьте приглашение в этот чат — и начните разговор.",
            input_message_content=types.InputTextMessageContent(
                message_text="<b>Приглашение в VoiceRooms</b>\n\n"
                "Присоединяйтесь к разговору. Голос, чат и показ экрана в одной комнате.\n"
                "<i>Приватная комната · сквозное шифрование</i>",
                parse_mode="HTML",
            ),
            reply_markup=room_buttons(code, key),
        )
        await query.answer([result], cache_time=1, is_personal=True)
    except Exception:
        log.warning("Inline invitation unavailable")
        await query.answer(
            [],
            cache_time=1,
            is_personal=True,
            button=types.InlineQueryResultsButton(
                text="Открыть VoiceRooms", start_parameter="help"
            ),
        )
    finally:
        if uid not in inline_cache:
            inline_locks.pop(uid, None)


@dp.message()
async def message_handler(message: types.Message):
    if message.chat.type != "private":
        return
    if message.from_user.id not in waiting:
        await message.answer(
            "Выберите действие ниже. Подсказка — /help.", reply_markup=menu()
        )
        return
    text = (message.text or "").strip()
    try:
        url = urlparse(text)
        code = parse_qs(url.query).get("room", [""])[0]
        key = parse_qs(url.fragment).get("key", [""])[0]
        invitation(code, key)
    except Exception:
        await message.answer(
            "Нужна полная ссылка с ключом: https://…/?room=…#key=…\nИли /cancel для отмены."
        )
        return
    try:
        await request(message.from_user.id, "/room/join", {"code": code})
        waiting.discard(message.from_user.id)
        await send_room(message, code, key)
    except Exception:
        await message.answer(
            "Комната закрыта или срок приглашения истёк. Попросите новую ссылку."
        )


@dp.callback_query()
async def old_button(query: types.CallbackQuery):
    await query.answer("Кнопка из прежней версии. Откройте /start.", show_alert=True)


async def main():
    bot = Bot(
        os.environ["BOT_TOKEN"],
        session=AiohttpSession(proxy=os.getenv("BOT_PROXY_URL") or None),
        default=DefaultBotProperties(parse_mode="HTML"),
    )
    me = await bot.get_me()
    if me.username != "vidagram_bot":
        await bot.session.close()
        raise RuntimeError("The configured token belongs to a different bot")
    # Do not discard pending updates: invitations and owner requests must survive a restart.
    await bot.set_my_commands(
        [
            types.BotCommand(command=c, description=d)
            for c, d in [
                ("start", "Открыть VoiceRooms"),
                ("help", "Как начать разговор"),
                ("cancel", "Отменить ввод"),
            ]
        ]
    )
    if OWNER:
        try:
            await bot.set_my_commands(
                [
                    types.BotCommand(
                        command="admin", description="Вход администратора"
                    ),
                    types.BotCommand(command="start", description="Открыть VoiceRooms"),
                ],
                scope=types.BotCommandScopeChat(chat_id=OWNER),
            )
        except Exception:
            log.warning(
                "Owner command menu is not available yet; /admin remains enabled after /start"
            )
    await bot.set_my_description(
        "VoiceRooms — голосовые комнаты по приглашению. "
        "Наберите @vidagram_bot в любом чате и отправьте приглашение участникам."
    )
    await bot.set_my_short_description(
        "Голос, чат и экран. Создавайте комнату прямо из любого чата."
    )
    await bot.set_chat_menu_button(
        menu_button=types.MenuButtonWebApp(
            text="VoiceRooms", web_app=types.WebAppInfo(url=SITE_URL)
        )
    )
    try:
        log.warning("VoiceRooms bot ready")
        await dp.start_polling(bot)
    finally:
        await bot.session.close()


if __name__ == "__main__":
    logging.basicConfig(level=logging.WARNING)

    class SafeFormatter(logging.Formatter):
        def format(self, record):
            return (
                super()
                .format(record)
                .replace(
                    os.environ.get("BOT_TOKEN", "unused-redaction-token"), "<redacted>"
                )
            )

    for handler in logging.getLogger().handlers:
        handler.setFormatter(SafeFormatter("%(levelname)s %(name)s: %(message)s"))
    try:
        asyncio.run(main())
    except Exception as error:
        log.error("Bot stopped: %s", type(error).__name__)
        sys.exit(1)
