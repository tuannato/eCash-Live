# Vendored libraries

Everything under `vendor/` is self-hosted so the app does **not** load any
third-party JavaScript at runtime. This protects against:

* CDN compromise (esm.sh / jsdelivr / unpkg historically have had incidents)
* DNS hijack of those CDNs
* CDN operators silently logging users
* CSP loosening for `script-src`

## What's in here

| File                          | Source                              | Version | Purpose                                              |
| ----------------------------- | ----------------------------------- | ------- | ---------------------------------------------------- |
| `vendor/chronik-client.js`    | npm `chronik-client`                | 3.7.0   | eCash blockchain indexer client (HTTP + WS)          |
| `vendor/qrcode-generator.js`  | npm `qrcode-generator`              | 1.4.4   | QR factory used by chat for outbound bip21 QRs       |
| `vendor/qrcode.js`            | npm `qrcode`                        | 1.5.3   | QR rendering used by the tip jar                     |
| `vendor/fonts.css`            | npm `@fontsource/space-grotesk` + `@fontsource/fira-code` | latest | `@font-face` declarations + unicode-range subsets |
| `vendor/fonts/*.woff2`        | (same as above)                     | latest  | 24 woff2 files: Latin / Latin-ext / Vietnamese, 4-5 weights each |

All three JS bundles were produced with `esbuild` from the upstream npm
tarballs whose `shasum` (sha1) matched the sha1 returned by the npm registry
for that version at build time.

## When to rebuild

* You want a newer upstream version.
* A CVE is announced upstream.
* Routine yearly hygiene.

You almost never need to rebuild for normal app development — these are
frozen dependencies.

## How to rebuild

You need Node.js + npm available locally (any LTS version works).

```bash
# 1. Set up a scratch directory
mkdir -p /tmp/rebuild && cd /tmp/rebuild
npm init -y >/dev/null

# 2. Install the exact versions + a bundler
npm install \
  chronik-client@3.7.0 \
  qrcode-generator@1.4.4 \
  qrcode@1.5.3 \
  @fontsource/space-grotesk \
  @fontsource/fira-code \
  esbuild \
  --no-audit --no-fund

# 3. Verify the installed tarball shasums against what npm advertised.
#    Trust nothing silently.
for pkg in chronik-client@3.7.0 qrcode-generator@1.4.4 qrcode@1.5.3; do
  name=${pkg%@*}
  version=${pkg##*@}
  echo "--- $pkg ---"
  curl -s "https://registry.npmjs.org/${name}/${version}" \
    | python3 -c "import json,sys; d=json.load(sys.stdin); print('registry shasum:', d['dist']['shasum'])"
  echo -n "local shasum:    "
  npm pack "$pkg" --dry-run --json 2>/dev/null \
    | python3 -c "import json,sys; print(json.load(sys.stdin)[0]['integrity'])"
done

# 4. Create the three ESM entry points
cat > entry-chronik.js <<'JS'
export { ChronikClient } from 'chronik-client';
JS

cat > entry-qrgen.js <<'JS'
import qrcode from 'qrcode-generator';
export default qrcode;
JS

cat > entry-qrcode.js <<'JS'
import QRCode from 'qrcode';
export default QRCode;
export { QRCode };
JS

# 5. Bundle each as a minified ESM module targeting modern browsers (es2020)
for entry in entry-chronik:chronik-client entry-qrgen:qrcode-generator entry-qrcode:qrcode; do
  src=${entry%:*}
  out=${entry##*:}
  ./node_modules/.bin/esbuild "${src}.js" \
    --bundle \
    --format=esm \
    --target=es2020 \
    --platform=browser \
    --minify \
    --outfile="${out}.js"
done

# 6. Smoke-test exports
node -e "import('./chronik-client.js').then(m => console.log('ChronikClient:', typeof m.ChronikClient))"
node -e "import('./qrcode-generator.js').then(m => { const qr=m.default(0,'M'); qr.addData('x'); qr.make(); console.log('qrgen OK', qr.getModuleCount()) })"
node -e "import('./qrcode.js').then(m => console.log('qrcode.toCanvas:', typeof m.default.toCanvas))"

# 7. Copy results into your repo's vendor/
cp chronik-client.js qrcode-generator.js qrcode.js /path/to/repo/vendor/
```

## How to rebuild the fonts

```bash
# In the same scratch directory (npm install above already pulled the
# @fontsource packages)
TARGET=/path/to/repo/vendor

# Space Grotesk: weights 300-700, Latin + Latin-ext + Vietnamese
for w in 300 400 500 600 700; do
  for sub in latin latin-ext vietnamese; do
    cp node_modules/@fontsource/space-grotesk/files/space-grotesk-${sub}-${w}-normal.woff2 \
       ${TARGET}/fonts/space-grotesk-${sub}-${w}.woff2
  done
done

# Fira Code: weights 300-600, Latin + Latin-ext
for w in 300 400 500 600; do
  for sub in latin latin-ext; do
    cp node_modules/@fontsource/fira-code/files/fira-code-${sub}-${w}-normal.woff2 \
       ${TARGET}/fonts/fira-code-${sub}-${w}.woff2
  done
done
```

`vendor/fonts.css` is hand-written (one block per weight/subset) so a font
swap requires updating it by hand. The unicode-range values mirror what
Google Fonts CSS2 serves so the browser still only fetches the subset
matching the characters on the page.

## After a rebuild

1. Reload the page locally and check the network panel — no requests to
   `esm.sh`, `cdn.jsdelivr.net`, `unpkg.com`, `fonts.googleapis.com`, or
   `fonts.gstatic.com`. All vendor assets should come from your origin.
2. Run `./update-csp-hash.sh index.html` if you also edited
   the inline script (you usually didn't — but check).
3. Commit `vendor/` together with the HTML file so users always get a
   coherent snapshot.
