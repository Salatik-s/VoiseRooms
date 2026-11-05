# Native synthetic media smoke test

This independent Linux CI fixture checks the LiveKit media transport. It does not run the VoiceRooms application, PostgreSQL, deployment scripts or any production service. The workflow triggers only for changes here or in its workflow on the release branch, and also supports manual dispatch.

The ephemeral GitHub runner starts LiveKit 1.13.11 on its private network interface, then connects two official Node native SDK clients. All access credentials and room names are generated for this run. No repository secrets are needed. The binary comes from the official livekit/livekit GitHub release and is checked against its pinned SHA256 release asset digest. npm ci verifies package-lock integrity; installation scripts are disabled. Native binaries come from the official @livekit/rtc-ffi-bindings optional npm packages.

Each mode must receive at least 100 decoded 20 ms frames containing the expected tone in **both directions** (440/660 Hz, 48 kHz mono), with non-silent RMS, and exactly one reliable data marker in each direction. The microphone source label identifies the WebRTC track type; samples come exclusively from generated Int16Array PCM and are never played through a speaker.

E2EE additionally requires GCM publications and enabled frame cryptors. A wrong-key receiver must first receive no loud decoded frames; after reconnecting with the correct key it must decode the expected tone. Reliable data delivery is checked, but this test makes no assertion that the data payload itself is E2EE encrypted.

Run through .github/workflows/media-transport.yml. The fixture refuses execution outside Linux GitHub Actions; it must never be pointed at a local user machine or production. Only JSON counters/results are uploaded. Raw native/server logs, SDP, tokens, ICE credentials and temporary configuration are deleted with the fixture.

A passing run proves native-to-native synthetic transport on that runner. It does not establish browser/native interoperability, microphone/speaker quality, physical Android/iPhone operation, mobile network traversal, or production TURN/TLS configuration.
