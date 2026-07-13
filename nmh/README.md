# Native Messaging Host

Registration artifacts for the Wisp NMH. The NMH binary itself is a
subcommand of the Nephele Workshop main executable
(`nephele.exe --nmh`), so this directory only holds:

- `com.arisfusion.nephele_wisp.json.template` — manifest template with
  `${NEPHELE_WRAPPER_PATH}` and `${ALLOWED_EXTENSION_IDS}` placeholders,
  resolved at install time by the Nephele installer.

## Registration flow (for reference; implemented in the Nephele repo)

When Nephele Workshop is installed, the installer:

1. Copies `com.arisfusion.nephele_wisp.json.template` to
   `%APPDATA%\Nephele\nmh\com.arisfusion.nephele_wisp.json`, filling
   `${NEPHELE_WRAPPER_PATH}` with a small wrapper script (a `.bat` that
   forwards to `nephele.exe --nmh %*`, because Chrome's NMH manifest
   `path` field cannot carry arguments directly).
2. Writes registry keys so Chrome and Edge discover the host:

   ```
   HKEY_CURRENT_USER\Software\Google\Chrome\NativeMessagingHosts\com.arisfusion.nephele_wisp
     (Default) = %APPDATA%\Nephele\nmh\com.arisfusion.nephele_wisp.json

   HKEY_CURRENT_USER\Software\Microsoft\Edge\NativeMessagingHosts\com.arisfusion.nephele_wisp
     (Default) = %APPDATA%\Nephele\nmh\com.arisfusion.nephele_wisp.json
   ```

3. On uninstall, removes both registry keys and deletes the manifest.

macOS paths (when Nephele ships for macOS in v0.5+):

```
~/Library/Application Support/Google/Chrome/NativeMessagingHosts/com.arisfusion.nephele_wisp.json
~/Library/Application Support/Microsoft Edge/NativeMessagingHosts/com.arisfusion.nephele_wisp.json
```

## Development (unpacked extension)

`extension/manifest.json` carries a fixed `key`, so the extension ID is
derived from that key — **not** from the load path. An unpacked load and
the distributed CRX therefore share one stable ID
(`fddgbflejpiodmhflebicicphlfobamj`), and `allowed_origins` needs only
that single entry:

```json
"allowed_origins": [
  "chrome-extension://fddgbflejpiodmhflebicicphlfobamj/"
]
```

That ID is baked into `core/browser/nmh_register.py` (`PROD_EXT_ID`), so
a fresh install whitelists it by default.

> Footgun (pre-`key` history): without the manifest `key`, Chrome/Edge
> derive the unpacked ID from a hash of the load path, so it drifts per
> path/profile and differs from the distributed build — which forced a
> two-ID whitelist and broke native messaging whenever either ID fell
> out of `allowed_origins`. The `key` removes this entirely.
> `WISP_DEV_EXT_ID` remains only as an override for a keyless legacy load.
