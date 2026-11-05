import importlib.util
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

spec = importlib.util.spec_from_file_location(
    "voicebot", Path(__file__).with_name("bot.py")
)
bot = importlib.util.module_from_spec(spec)
spec.loader.exec_module(bot)


class Query:
    def __init__(self, text=""):
        self.from_user = SimpleNamespace(id=42)
        self.query = text
        self.answer = AsyncMock()


class BotTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        bot.inline_cache.clear()
        bot.inline_locks.clear()

    async def test_inline_keystrokes_reuse_room_and_keep_deep_link_under_64_bytes(self):
        with patch.object(
            bot, "new_room", AsyncMock(return_value=("ABCDEFGH", "k" * 43))
        ) as create:
            a, b = Query("Hi"), Query("Hi there")
            await bot.inline(a)
            await bot.inline(b)
            create.assert_awaited_once()
            result = a.answer.call_args.args[0][0]
            for row in result.reply_markup.inline_keyboard:
                for button in row:
                    self.assertNotIn("token=", button.url)
            deep = result.reply_markup.inline_keyboard[0][0].url.split("start=")[1]
            self.assertLessEqual(len(deep), 64)
            self.assertIn("#key=", result.reply_markup.inline_keyboard[1][0].url)

    async def test_inline_failure_is_answered_and_does_not_crash_polling(self):
        q = Query()
        with patch.object(bot, "new_room", AsyncMock(side_effect=TimeoutError())):
            await bot.inline(q)
        self.assertEqual(q.answer.call_args.args[0], [])

    async def test_non_text_message_in_join_flow_does_not_crash(self):
        message = SimpleNamespace(
            chat=SimpleNamespace(type="private"),
            from_user=SimpleNamespace(id=42),
            text=None,
            answer=AsyncMock(),
        )
        bot.waiting.add(42)
        await bot.message_handler(message)
        self.assertIn("полная ссылка", message.answer.call_args.args[0])

    async def test_apps_command_links_to_public_installation_instructions(self):
        message = SimpleNamespace(answer=AsyncMock())
        await bot.apps_command(message)
        text = message.answer.call_args.args[0]
        self.assertIn("компьютер", text)
        self.assertIn("Apple ID", text)
        markup = message.answer.call_args.kwargs["reply_markup"]
        self.assertEqual(markup.inline_keyboard[0][0].url, bot.SITE_URL + "/download")

    async def test_owner_pair_code_is_not_sent_to_other_users(self):
        message = SimpleNamespace(chat=SimpleNamespace(type="private"),from_user=SimpleNamespace(id=42),answer=AsyncMock())
        with patch.object(bot, "OWNER", 99), patch.object(bot, "request", AsyncMock()) as request:
            await bot.admin_command(message)
        request.assert_not_awaited()

    async def test_owner_code_stays_protected_and_does_not_advertise_private_packages(self):
        message = SimpleNamespace(chat=SimpleNamespace(type="private"),from_user=SimpleNamespace(id=99),answer=AsyncMock())
        with patch.object(bot, "OWNER", 99), patch.object(bot, "request", AsyncMock(return_value={"code":"TEST-PAIR"})):
            await bot.admin_command(message)
        text = message.answer.call_args.args[0]
        self.assertNotIn("приложении администратора", text)
        self.assertTrue(message.answer.call_args.kwargs["protect_content"])

    def test_invitation_rejects_injected_or_incomplete_values(self):
        with self.assertRaises(ValueError):
            bot.invitation("x<script>", "k" * 43)
        with self.assertRaises(ValueError):
            bot.invitation("ABCDEFGH", "short")

    async def test_generated_invitation_uses_the_same_admission_protocol(self):
        import hashlib

        with (
            patch.object(bot.secrets, "token_urlsafe", return_value="A" * 43),
            patch.object(
                bot, "request", AsyncMock(return_value={"code": "ABCDEFGH"})
            ) as request,
        ):
            code, key = await bot.new_room(42)
        golden = "ae91ac6d8c0c08aeaddf908479e3a6fe4d9395bb0343e4fd13a6ab6c7d0aa9a9"
        self.assertEqual(
            request.call_args.args[2]["accessHash"],
            hashlib.sha256(golden.encode()).hexdigest(),
        )
        self.assertEqual(key, "A" * 43)

    def test_menu_uses_real_actions_and_primary_style(self):
        menu = bot.menu()
        self.assertEqual(menu.inline_keyboard[0][0].style, "primary")
        self.assertEqual(menu.inline_keyboard[2][0].switch_inline_query, "")


if __name__ == "__main__":
    unittest.main()
