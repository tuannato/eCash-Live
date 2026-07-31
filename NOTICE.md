# NOTICE — the scope of the MIT license

`LICENSE` (MIT) covers the **source code** of eCash Live: the HTML, CSS and
JavaScript written for this project, `ttf-relay.py`, the Workers under
`worker/` and `worker-api/`, and the tooling (`update-csp-hash.sh`,
`project-index.py`).

It does **not** cover the items below. Some are third-party works under their
own licenses. Others are images this project does not own, and therefore
cannot license to anyone — saying so plainly is cheaper than letting someone
rely on a grant that was never ours to make.

---

## 1. Images this project does not own

### eChan — `vendor/companion/sprites/` (29 files)

eChan is a mascot of the **eCash community**, not a character owned by this
project. The sprites here were rendered with AI from artwork the eCash
community has shared.

This project therefore claims **no copyright** in them and grants **no
license** to them. They are in the repository because the site needs them to
run — that is the whole extent of it. Anyone wanting to reuse eChan artwork
should look to the eCash community rather than to this repository, and reach
their own conclusion about provenance.

### eCash brand marks

The eCash logo and wordmark belong to the eCash project / Bitcoin ABC. They
appear here as inline SVG paths in `index.html` and `flow/index.html` and are
**not** sublicensed by this repository.

### YouTube thumbnails — `vendor/mediacenter/cards/yt-*.jpg`

Cover images for third-party videos. They belong to the respective video
creators. Not licensed here.

### Site identity images

`favicon.ico`, `icon-32/180/192/512.png`, `icon-1200x630.png`, `og-card.jpg`,
`og-square.jpg`, `vendor/flow-wordmark.png`,
`vendor/flow-wordmark-purple.png`, and the remaining
`vendor/mediacenter/cards/*.webp`.

These identify this site and are excluded from the MIT grant. Where any of
them were produced with AI from community-shared references, the eChan
paragraph above applies to them equally: no copyright is claimed, and no
license is granted.

> **In short: take the code, not the pictures.**

---

## 2. Third-party components

### Fonts — SIL Open Font License 1.1

`vendor/fonts/` ships 23 `.woff2` subsets of two families:

| Family | Copyright | License |
|---|---|---|
| Space Grotesk | © Florian Karsten | SIL OFL 1.1 |
| Fira Code | © The Fira Code Project Authors | SIL OFL 1.1 |

The full license text is in [`vendor/fonts/OFL.txt`](vendor/fonts/OFL.txt).
OFL 1.1 requires that this text travel with the fonts, so it must not be
removed when the `vendor/` directory is copied.

### JavaScript

| File | Upstream | License |
|---|---|---|
| `vendor/chronik-client.js` | Bitcoin ABC — `modules/chronik-client` | MIT |
| `vendor/cashtab-connect.js` | Bitcoin ABC — `modules/cashtab-connect` | MIT |
| `vendor/qrcode.js`, `vendor/qrcode-generator.js` | qrcode-generator (Kazuhiko Arase) | MIT |

`vendor/txparse.js`, `vendor/door.js`, `vendor/companion/echan.js` and
`vendor/mediacenter/mediacenter.js` are this project's own code and are
covered by `LICENSE`.

See [`VENDOR.md`](VENDOR.md) for why each dependency is self-hosted and how to
refresh it.

---

## 3. Data

The finality measurements published by this project (`/history`, the daily
rollups behind it, and the numbers rendered on both doors) are produced by
`ttf-relay.py` from a node's own logs. The code that produces them is MIT.
The measurements themselves are published as fact, not as a licensed work —
reuse them, and cite where they came from so a reader can check them.
