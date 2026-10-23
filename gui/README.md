# XID Wallet: the desktop app (Windows)

This is the graphical wallet for xCoin (XID), built for Windows first. It also runs on macOS and Linux, which is how it is developed. It uses the acid lime brutalist look, with a day (light) and a night (dark) mode.

## How it is built

| Part | What it is |
|---|---|
| `app.py` | Opens the window. It uses pywebview, which draws with the system's own web view: Edge WebView2 on Windows, WebKit on macOS. The page talks to Python through pywebview's bridge only: there is no web server, no open port, and nothing is fetched from the internet to draw the app. |
| `backend.py` | Runs the command-line wallet's own commands (`wallet_cli.py`) in-process, with JSON output. Coin selection, fees, offline signing with the keytool, and every safety check are the same code the CLI's 353 tests cover; nothing about money is written twice. |
| `ui/` | The screens: `index.html`, `styles.css` (color tokens, light and dark), `app.js`, the bundled fonts (Big Shoulders Display and IBM Plex, OFL), and `identicon.js`, the xCoin tetromino identicon used by MMM, superknet.com and the forum. |
| `ui/preview.html` | Development only, never packaged. The real screens with a stand-in backend and sample data, so any browser can show every screen: `?screen=welcome\|unlock\|overview\|receive\|send\|coins\|identity\|settings&theme=light\|dark`. |

**Keys and the identity**
- **Funds live at index 0.** Receive, Overview, Send and Coins all use it.
- **The XID identity is key index 99,999,999**, the 100-millionth key, and AYEDEX uses the same key. It is a public name: nothing can be paid to it.
- **Nobody can trace the identity to your balance.** Every key index is its own SHAKE-256 child of the seed, so the identity says nothing about index 0.
- An xid1 identity does reveal the simplest (single-leaf) address of its own key. So the app refuses to receive at, show, or spend from index 99,999,999.

**The passphrase**
- It reaches the engine the way a parent program hands it over (the `--passphrase-fd` channel), never through the environment.
- The app keeps it in memory only while the wallet is unlocked: it is dropped when you lock, and after 10 minutes without use.
- The seed is decrypted for each action and never kept.

## Forum sign-in (MineDifferent)

Identity, **Sign in to MineDifferent**:
1. The app asks minedifferent.com for a challenge (`POST /api/challenge/new`).
2. It signs the challenge's four-line message with the XID identity (key 99,999,999) through the engine's `signmessage`, on this computer.
3. It also signs the challenge with key 101 of the same wallet, adding a line that names the new identity (`carry-to: xid1…`). Key 101 is the key NerdMiner and MMM signed in with, so the forum moves an account that key holds to the XID identity, once (name, threads, posts, chat, role).
4. It posts the identity, its public key and the signature, plus key 101's (`POST /api/challenge/<id>/solve`).
5. It opens the one-time sign-in link the forum returns in the default browser.

Only public data leaves the computer. The forum account is the `xid1…` of key 99,999,999.

## Run it while developing

```bash
python3 -m venv gui/.venv && gui/.venv/bin/pip install -r gui/requirements.txt
./build.sh                    # the keytool, next to wallet_cli.py (CMake on Linux and Windows)
gui/.venv/bin/python gui/app.py
```

On Windows, use `gui\.venv\Scripts\python gui\app.py`.

Settings are kept in `~/.xcoin/gui-settings.json` and are not secret: the theme, the network, the explorer, and which wallet file is open. Wallet files are the CLI's `.mmm` files, so the app and the CLI open the same wallet.

## Build the portable Windows app (on a Mac)

This is how the released zip is made:

```bash
gui/build-portable.sh          # needs zig and python3; downloads from python.org (Sigstore-verified) and PyPI
```

It produces `dist/XID Wallet/` and `dist/XID-Wallet-Windows-portable-<version>.zip`, with its SHA-256 in a `.sha256` file beside it. Put that hash in the repository README's file integrity table with every release.

| In the folder | What it is |
|---|---|
| `XID Wallet.exe` | What people double-click. `launcher/xid-wallet.c`, cross-compiled with zig, with the xCoin icon, version information and the same manifest as Python's `pythonw.exe`. It runs `app\gui\app.py` inside its own process with the bundled Python, so Windows shows one app named XID Wallet. |
| `runtime\` | The official embeddable Python 3.12 and the app's Windows libraries. |
| `app\` | The wallet engine, the keytool (`xcoin-wallet.exe`, cross-compiled with zig), the app, and `XID Wallet (debug).cmd`, which shows startup errors in a console. |

The icon is drawn by `assets/make_icon.py` from the official xCoin mark (the black XID glyph in the acid lime circle on xcoinproject.com). In the app, Settings, Shortcuts runs `shortcuts.ps1` to put it on the desktop and in the Start menu.

## Build the Windows app with PyInstaller (on Windows)

On Windows with Python 3.12, CMake and Visual Studio's C++ tools, run:

```powershell
powershell -ExecutionPolicy Bypass -File gui\build-windows.ps1
```

It produces:
- `dist\XID Wallet\XID Wallet.exe`;
- `dist\XID-Wallet-windows.zip`, with its SHA-256 in a file beside it.

The `windows-app` job in `.github/workflows/ci.yml` runs the same script on every push and uploads the zip.

Before a public release, sign the program, or Windows SmartScreen will warn on first run. Microsoft's Trusted Signing costs about $10 a month and needs DLT verified as a business.

## Not in this version yet

| Feature | Status |
|---|---|
| Card wallets (NTAG 424 DNA) | The engine supports them. The app needs the card prompts drawn as screens, and testing with a USB reader in a Windows virtual machine. |
| Full payment history | The explorer has no history API, so the app lists the coins you hold and links to the explorer's address page. With your own node, the CLI's `history` works. |
| A local node | The CLI already talks to a node by RPC. The app uses the explorer for now. |
