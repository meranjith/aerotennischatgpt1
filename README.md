# AeroTennis v2 — clean motion/audio core

This build is intentionally independent of the previous prototype architecture.

## Core rules

- Right-side ball = forehand = screen-forward at impact.
- Left-side ball = backhand = flip phone so back panel is forward at impact.
- Normal swing = exactly 1000 ms receiver approach.
- Fast swing = exactly 500 ms receiver approach.
- Practice mode is local and does not depend on multiplayer state.
- One approach audio voice can exist at a time.
- Approach direction is baked into a 2-channel AudioBuffer; the non-target channel is all zeros.
- No service worker is used, avoiding stale PWA audio code during testing.

## GitHub Pages

Upload all files to the repository root and enable GitHub Pages from the main branch root.
Open the resulting HTTPS page on the phone.

## Important limitation

Browser motion/orientation behavior is device-dependent. HTTPS and sensor permission are required. PeerJS provides signaling while WebRTC carries the peer data connection.
