# Chess Gym

A chess trainer for building intuition, not memorizing openings. Everything runs in the browser, on-device.

- **Stockfish 18** (WASM) works out what's *true*: the best move, the line, the threats.
- **Maia-3** (ONNX, human-like) works out what's *human*: how often players at your rating make each move.
- A **deterministic explainer** (`js/analysis.js`) turns board geometry into plain language: forks, pins, skewers, discovered attacks, mate threats, loose pieces. It never makes up moves.

## Training loops

| Feature | What it trains |
|---|---|
| Threat check | Before each move, tap what the opponent's last move is after. Uses a "free move" (null-move) search to find their real idea. |
| Move review | Verdict (win % lost), the human-vs-engine quadrant (*hidden gem*, *natural*, *common trap*, *off-track*), why the better move works, and how they'd punish yours. |
| 👁 Idea preview | Step through the engine's line move by move, with numbered arrows and a note on what each move attacks. |
| Hint ladder | 4 steps: scan forcing moves → which piece → which idea → the move. |
| Layers | Threats (your loose pieces), Control (who owns each square), Engine plan, Humans (Maia's top moves). |
| Drills | Your own mistakes come back on a spaced schedule (Leitner boxes). |
| Style | You vs. the best move on forcing/threat/king pressure/trades/pawn moves, blind spots, and "who you play like" (Maia likelihood across ratings). |

## Run locally

```sh
python3 -m http.server 8000   # then open http://localhost:8000
```

On first use, press **Load Maia-3**. This downloads `maia3-5m.fp16.onnx` (~11 MB, a community ONNX export of the official weights) and caches it. If it can't be downloaded, Stockfish plays instead, and you can load an `.onnx` file by hand.

## Tests

```sh
python3 test/ref_encode.py && node test/check_encode.mjs   # JS encoding == official Maia-3 encoding
node test/check_analysis.mjs                                # motif detector
python3 test/make_dummy.py && python3 test/e2e.py           # full browser run with a dummy model of the same I/O
```

## Licenses

AGPL-3.0. Maia-3 (CSSLab, AGPL-3.0) and Stockfish (GPL-3.0) are both GPL-family licenses. Pieces: cburnett set (via chessground, GPL). chess.js: BSD-2. onnxruntime-web: MIT.

## Android app

`android/` is a small WebView wrapper. It serves the same files from `https://appassets.androidplatform.net/`, so modules, workers, WASM and the model cache all work offline.

- **Built for you:** every push to `main` runs `.github/workflows/android.yml`. It builds the APK and attaches it to the **latest** release (Releases → Latest build → `chess-gym.apk`).
- **Local build** (needs the Android SDK): `gradle -p android assembleDebug`

It's a debug-signed build. Android will ask you to allow installs from your browser or file manager the first time.
