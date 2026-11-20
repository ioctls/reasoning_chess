# Notices

Reasonable Chess is free software under the GNU Affero General Public License v3.0 (see LICENSE).
Source code: https://github.com/ioctls/reasoning_chess

It includes the following third-party components:

| Component | Author | License | Where |
|---|---|---|---|
| Stockfish 18 (lite, single-threaded WASM build via the `stockfish` npm package) | The Stockfish developers | GPL-3.0 | `vendor/stockfish/` |
| Maia-3 5M model weights (ONNX export `bqrio/maia3-onnx`, revision `923df9a2`) | University of Toronto CSSLab (McIlroy-Young, Anderson et al.) | AGPL-3.0 | `models/` (downloaded at build time) |
| ONNX Runtime Web 1.23 | Microsoft | MIT | `vendor/ort/` |
| chess.js 1.4 | Jeff Hlywa | BSD-2-Clause | `vendor/chess/` |
| cburnett chess pieces | Colin M.L. Burnett | GPL (via chessground assets) | `js/pieces.js` |
| AndroidX WebKit and Core | The Android Open Source Project | Apache-2.0 | Android app |
