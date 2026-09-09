# AeroTennis — working motion/audio revision

This revision focuses on the gameplay state machine and sensor math.

## Fixed
- Forehand/backhand face detection now compares the phone's calibrated screen normal in world space.
- Acceleration is transformed into the calibrated frame with the correct quaternion direction.
- Swing detection uses the acceleration peak and emits exactly one swing event, followed by a longer refractory period.
- A stale ball timer cannot resolve a newer ball because every ball has a token.
- A successful hit invalidates its miss timer immediately.
- Practice returns are deliberately delayed so the next ball does not appear immediately after a receipt.
- Audio approach playback remains one voice at a time; hit/miss stops the approach before playing the result sound.
- Hit timing tolerates mobile sensor/audio latency: 360 ms early to 420 ms late.

## Use
1. Serve the site over HTTPS.
2. Allow motion/orientation permissions.
3. Run the stereo test with headphones.
4. Calibrate while holding the phone in the neutral screen-forward racket position.
5. In Wall Mode, RIGHT means screen side forward; LEFT means back side forward.

## Verification
`npm test` passes the deterministic rally/audio timing rules included in `tests.mjs`.

Browser motion sensors are hardware/browser dependent, so the final validation must be done on the target phone.
