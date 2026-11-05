# VoiceRooms design

The owner selected familiar Telegram call conventions: neutral charcoal canvas, restrained blue actions, green speaking state, red leave action, circular initial avatars and a persistent bottom control dock. No decorative illustration is needed for this operating surface.

Use the native system UI sans stack for familiar platform rendering and Cyrillic. Titles 24–30px, participant names 18px, body 16px, utility labels 13–14px. Labels remain visible. Keyboard focus uses a high-contrast blue outline. Respect reduced motion.

The call is the primary canvas; chat and participant management occupy one dismissible sidebar. On phones the sidebar becomes a sheet above the controls. The local development preview uses the same RoomView as the real LiveKit call, explicitly labels illustrative data, and never starts media or publishes messages.

Phone controls use a large microphone button in the center, with screen, participants and chat on either side and a separate red leave button at the far right. Minimum interactive target is 44px. Chat uses a dismissible sheet, 16px input text and visualViewport height updates to keep its composer within the visible area when the software keyboard changes it. The entry screen includes a microphone choice before joining.
