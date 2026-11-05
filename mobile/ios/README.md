# iPhone application

VoiceRooms for iPhone uses the same mobile interface and server authorization as the website. Microphone access is requested only when the user enables it. The application requires iOS 17 or newer.

The IPA build is unsigned. Install it through a tool such as [Sideloadly](https://sideloadly.io/) using your own Apple ID. It cannot be installed by opening the downloaded file in Safari. Free personal signing expires and must be refreshed. No developer account credentials are stored in the source or IPA.

The iPhone GitHub Actions job compiles an arm64 iPhone application, packages a Payload/VoiceRooms.app IPA, and runs UI checks in an iPhone Simulator. Real microphone, speaker, background calling and physical-device installation still require device testing. Screen capture depends on the WebKit capabilities of the device.
