# VoiceRooms for Android

Android 8.0 and newer. The app displays the same phone interface as the website and connects to `https://voise.24projects.ru`. An internet connection is required.

Microphone access is requested when the user enables it. Users may join as listeners. Active calls have a foreground notification with a return action and a leave action. Session tokens are encrypted with Android Keystore. Application links preserve the room invitation fragment.

Only the application's HTTPS origin receives the native bridge. Other HTTPS links open externally. TLS errors are never bypassed. The release build disallows cleartext traffic. A debug-only emulator origin is used for automated visual checks.

Screen sharing depends on the browser engine. Android WebView does not expose `getDisplayMedia`; the interface explains how to use a supported desktop browser instead. Real-device microphone, speaker, Bluetooth and background behavior require a separate device test.

## Build

Use JDK 17 or newer, Android SDK platform 35, and build-tools 34.0.0. Set `ANDROID_HOME` or create an ignored `local.properties` with your SDK path.

```sh
bash gradlew testReleaseUnitTest assembleRelease lintRelease
```

Without signing environment variables, this creates an unsigned release APK. Release signing uses `VR_KEYSTORE`, `VR_KEYSTORE_PASSWORD`, `VR_KEY_ALIAS` and `VR_KEY_PASSWORD`. Keep signing material outside the repository.

The CI workflow compiles the debug and instrumented test APKs, then starts a phone emulator. The tests inspect the shared call interface, microphone-state control, chat, system Back, Russian error UI and retry recovery. They use an illustrative local call and do not capture microphone audio.
