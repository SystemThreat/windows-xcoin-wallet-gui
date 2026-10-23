"""The XID Wallet app's bridge to the wallet engine.

Every wallet action runs the command-line wallet's own command, in this process, with JSON output:
the same coin selection, fee rules, offline signing and safety checks the CLI's tests cover. The
passphrase reaches the engine through the channel a parent program uses (--passphrase-fd), never
the environment. The seed is decrypted per action and never kept by the app; the passphrase is kept
in memory while the wallet is unlocked and dropped on lock or after the idle timeout.
"""
import contextlib, io, json, os, sys, threading, time
from pathlib import Path

HERE = Path(getattr(sys, "_MEIPASS", Path(__file__).resolve().parent))   # PyInstaller unpacks beside the program
ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
import wallet_cli as w   # noqa: E402

# The app never asks at a terminal: a prompt would wait on a console nobody sees and hold the engine lock, so every
# later action would hang. Without a passphrase the engine answers "no terminal", which the app shows as "locked".
w.can_prompt = lambda: False

IDENTITY_INDEX = 99_999_999          # the XID identity: key number 100,000,000 (AYEDEX uses the same key)
# Funds live at index 0 and up. Every index is its own SHAKE-256 child of the seed, so the identity says nothing
# about any other key; but an xid1 identity does reveal its own key's single-leaf address, so the app never pays
# to, shows, or spends from the identity's index.


def payment_index(index):
    i = int(index)
    if i < 0: raise w.WalletError("an address index is 0 or more")
    if i == IDENTITY_INDEX: raise w.WalletError("index 99,999,999 is your XID identity, never a payment address")
    return str(i)
DEFAULT_EXPLORER = "https://superknet.com"
FORUM = "https://minedifferent.com"     # MineDifferent: sign in with the XID identity (key 99,999,999)
SETTINGS = Path.home() / ".xcoin" / "gui-settings.json"
PENDING = Path.home() / ".xcoin" / "gui-pending.json"   # this app's sends that have not confirmed yet (public data only)
IDLE_LOCK_SECONDS = 10 * 60
PENDING_DROP_SECONDS = 60 * 60          # a send whose coins are back, unspent and out of the mempool, after an hour did not confirm
PENDING_MAX_SECONDS = 3 * 24 * 3600


class Engine:
    """Runs CLI commands in-process, one at a time (the engine keeps a few module-level flags)."""
    def __init__(self):
        self._lock = threading.Lock()
        self.settings = {"theme": "system", "explorer": DEFAULT_EXPLORER, "hrp": "xpa", "file": str(w.default_wallet())}
        try:
            self.settings.update(json.loads(SETTINGS.read_text()))
        except (OSError, ValueError):
            pass
        self._passphrase = None
        self._touched = 0.0
        self.pub = None          # public data of index 0 and the identity, derived at unlock (no seed kept)

    # ── settings (nothing secret here) ──
    def save_settings(self):
        SETTINGS.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
        SETTINGS.write_text(json.dumps(self.settings, indent=1))

    @property
    def file(self): return self.settings["file"]

    # ── running a command ──
    def run(self, *argv, passphrase=None, use_backend=True):
        base = ["--file", self.file, "--json", "--hrp", self.settings["hrp"]]
        if use_backend: base += ["--explorer", self.settings["explorer"]]
        out, err = io.StringIO(), io.StringIO()
        with self._lock:
            given = passphrase if passphrase is not None else self._session_passphrase()
            w.PASSPHRASE_FROM_FD = given
            try:
                with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
                    rc = w.main([*base, *argv])
            except SystemExit as e:
                rc = e.code
            finally:
                w.PASSPHRASE_FROM_FD = None
        text = out.getvalue().strip()
        if rc not in (0, None):
            lines = [l for l in err.getvalue().splitlines() if l.strip()]
            errs = [l for l in lines if l.startswith("error: ")]
            msg = (errs[-1] if errs else (lines[-1] if lines else "")) or text or f"the wallet stopped (code {rc})"
            if w.NO_TERMINAL in msg:   # the engine would ask at a terminal: here that means the passphrase was wrong, or none
                raise w.WalletError("That passphrase does not open this wallet." if given else "The wallet is locked.")
            raise w.WalletError(msg[len("error: "):] if msg.startswith("error: ") else msg)
        if text.startswith(("{", "[")):
            return json.loads(text)
        return text

    # ── session ──
    def _session_passphrase(self):
        if self._passphrase is None: return None
        if time.monotonic() - self._touched > IDLE_LOCK_SECONDS:
            self.lock(); return None
        self._touched = time.monotonic()
        return self._passphrase

    def unlock(self, passphrase):
        """Open the wallet once (one passphrase check, or one card tap) and keep only public data: the
        index-0 addresses and scripts and the identity. Balances need nothing more; signing opens it again."""
        hrp = self.settings["hrp"]
        err = io.StringIO()
        with self._lock:
            w.PASSPHRASE_FROM_FD = passphrase
            try:
                with contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(err):
                    seed = w.read_seed(self.file)
                    try:
                        zero = w.derive_offline(seed, 0, hrp)
                        ident = w.derive_offline(seed, IDENTITY_INDEX, hrp)
                    finally:
                        seed = None
            except w.WalletError as e:
                if w.NO_TERMINAL in str(e): raise w.WalletError("That passphrase does not open this wallet.")
                raise
            except Exception as e:
                line = w.card_error_line(e, "unlock")
                if line is None: raise
                raise w.WalletError(line)
            finally:
                w.PASSPHRASE_FROM_FD = None
        self.pub = {"address": zero["address"], "scriptPubKey": zero["scriptPubKey"],
                    "carried_address": zero["carried_address"], "carried_scriptPubKey": zero["carried_scriptPubKey"],
                    "identity": ident["identity"], "hrp": hrp}
        self._passphrase, self._touched = passphrase, time.monotonic()

    def lock(self):
        self._passphrase = None
        self.pub = None

    # ── what the explorer says, and this app's own sends that have not confirmed yet ──
    def explorer_view(self):
        """Index 0's coins (both script forms) from the explorer's /api/utxos, which leaves out coins a waiting
        transaction already spends and lists those as pending_spent. Returns (height, mature, immature, pending_spent)."""
        if not self.unlocked or not self.pub: raise w.WalletError("The wallet is locked.")
        self._touched = time.monotonic()
        rpc = w.ExplorerRPC(self.settings["explorer"], self.settings["hrp"])
        unspents, pending_spent, height, seen = [], set(), 0, set()
        for addr, kind in ((self.pub["address"], "two_leaf"), (self.pub["carried_address"], "carried")):
            out = rpc._get(f"/api/utxos/{addr}")
            if not isinstance(out, dict) or not isinstance(out.get("utxos"), list):
                raise w.WalletError(f"the explorer returned no coin list for {addr}")
            height = max(height, int(out.get("height") or 0))
            for u in out["utxos"]:
                key = f'{u["txid"]}:{u["vout"]}'
                if key in seen: continue
                seen.add(key)
                unspents.append({"txid": u["txid"], "vout": u["vout"], "amount": u["amount"], "kind": kind,
                                 "coinbase": bool(u.get("coinbase")), "height": u.get("height"), "confirmations": u.get("confirmations")})
            pending_spent |= {f'{p["txid"]}:{p["vout"]}' for p in out.get("pending_spent") or []}
        mature, immature = w.classify_utxos({"height": height, "unspents": unspents})
        return height, mature, immature, pending_spent

    def _pending_key(self):
        return f"{Path(self.file).resolve()}|{self.settings['hrp']}"

    def pending_sends(self):
        try: return json.loads(PENDING.read_text()).get(self._pending_key(), [])
        except (OSError, ValueError): return []

    def _save_pending(self, items):
        try: book = json.loads(PENDING.read_text())
        except (OSError, ValueError): book = {}
        if items: book[self._pending_key()] = items
        else: book.pop(self._pending_key(), None)
        PENDING.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
        PENDING.write_text(json.dumps(book, indent=1))

    def record_send(self, sent, amount, to, before):
        """Remember a broadcast send until its change (or, with no change, the disappearance of its coins) is
        confirmed, so the balance shows the subtraction at once instead of dropping to what is left confirmed."""
        D = w.Decimal
        fee = D(str(sent.get("fee") or 0))
        entry = {"txids": sent.get("txids") or [sent["txid"]], "to": to, "amount": w.fmt8(D(str(amount))), "fee": w.fmt8(fee),
                 "spent": list(sent.get("spent") or []), "change_outputs": list(sent.get("change_outputs") or []),
                 "before": w.fmt8(D(str(before))), "after": w.fmt8(D(str(before)) - D(str(amount)) - fee), "at": time.time()}
        self._save_pending(self.pending_sends() + [entry])

    def balance_view(self):
        """The balance a person expects: the coins they can spend now plus the change of their own sends on its way
        back. Each waiting send carries its arithmetic (before - sent - fee = after); it drops out once confirmed."""
        D = w.Decimal
        height, mature, immature, pending_spent = self.explorer_view()
        confirmed = {f'{u["txid"]}:{u["vout"]}' for u in mature + immature}
        now, active, dropped = time.time(), [], []
        for e in self.pending_sends():
            change = [f'{c["txid"]}:{c["vout"]}' for c in e["change_outputs"]]
            back = [o for o in e["spent"] if o in confirmed and o not in pending_spent]   # listed unspent, not in the mempool
            waiting = [o for o in e["spent"] if o in pending_spent]
            if change and all(c in confirmed for c in change): continue                    # the change arrived: confirmed
            if not change and not back and not waiting: continue                           # its coins are gone for good: confirmed
            if (back and not waiting and now - e["at"] > PENDING_DROP_SECONDS) or now - e["at"] > PENDING_MAX_SECONDS:
                dropped.append(e); continue                                                # never confirmed: its coins count again
            active.append(e)
        self._save_pending(active)
        excluded = {o for e in active for o in e["spent"]}   # coins a waiting send spends, even if a stale scan still lists them
        spendable = sum((u["amount"] for u in mature if f'{u["txid"]}:{u["vout"]}' not in excluded), D(0))
        maturing = sum((u["amount"] for u in immature if f'{u["txid"]}:{u["vout"]}' not in excluded), D(0))
        confirming = sum((D(str(c["amount"])) for e in active for c in e["change_outputs"]
                          if f'{c["txid"]}:{c["vout"]}' not in confirmed), D(0))
        return {"height": height, "spendable": spendable, "confirming": confirming, "balance": spendable + confirming,
                "immature": maturing, "pending": active, "dropped": dropped,
                "mature": [u for u in mature if f'{u["txid"]}:{u["vout"]}' not in excluded],
                "immature_coins": [u for u in immature if f'{u["txid"]}:{u["vout"]}' not in excluded]}

    @property
    def unlocked(self):
        if self._passphrase is not None and time.monotonic() - self._touched > IDLE_LOCK_SECONDS: self.lock()
        return self._passphrase is not None


VERSION = "2.0.0-test12"
_SELFTEST = None


def keytool_selftest():
    """The keytool replays the node's witness v3 golden vectors once per run: a build that fails them must not sign."""
    global _SELFTEST
    if _SELFTEST is None:
        import subprocess
        tool = w.keytool_path()
        if not tool:
            _SELFTEST = "the keytool (xcoin-wallet) is missing next to the wallet engine"
        else:
            try:
                flags = getattr(subprocess, "CREATE_NO_WINDOW", 0)
                r = subprocess.run([str(tool), "_v3vectors"], capture_output=True, timeout=60, creationflags=flags)
                _SELFTEST = "ok" if r.returncode == 0 else f"the keytool failed its self-test: {r.stderr.decode(errors='replace').strip()[:300]}"
            except Exception as e:
                _SELFTEST = f"the keytool could not run: {e}"
    return _SELFTEST


def backup_path(picked, ext=".mmm"):
    """Where a backup goes: the name chosen in the save dialog, ending in the wallet's extension exactly once.
    "wallet001" gets it, "wallet001.mmm" (any case) keeps the name it has, and trailing dots and spaces, which
    Windows drops from file names, never leave "wallet001..mmm"."""
    p = Path(picked)
    name = p.name.rstrip(". ")
    if not name.lower().endswith(ext.lower()): name += ext
    return str(p.with_name(name))


def qr_svg(text):
    """A QR code as SVG markup (black modules, no background: the page sets the paper colour)."""
    import qrcode
    from qrcode.image.svg import SvgPathImage
    img = qrcode.make(text, image_factory=SvgPathImage, box_size=10, border=0,
                      error_correction=qrcode.constants.ERROR_CORRECT_M)
    buf = io.BytesIO(); img.save(buf)
    return buf.getvalue().decode()


class Api:
    """What the page can call (window.pywebview.api.*). Every method returns {"ok": ...} or {"error": "..."}."""
    def __init__(self):
        self._e = Engine()
        self._window = None

    _NO_READER = ("Smart Card Resource Manager is not running", "0x8010001D", "No readers", "no smart card reader", "0x8010002E")

    def _wrap(self, fn, *a, **k):
        try:
            return {"ok": fn(*a, **k)}
        except Exception as ex:   # never a traceback in the window
            msg = str(ex) if isinstance(ex, w.WalletError) else f"{type(ex).__name__}: {ex}"
            if any(t.lower() in msg.lower() for t in self._NO_READER):   # Windows starts its card service only when a reader is attached
                msg = "No card reader found. Plug in the USB card reader (for example an ACS ACR1252U), wait a few seconds, and try again."
            return {"error": msg}

    # ── state and settings ──
    def state(self):
        def go():
            fmt, card = w._wallet_format(self._e.file)
            seed_reveal = None   # may this card wallet ever show its seed? Known only once it is unlocked (the mark is passphrase-sealed)
            if fmt == "mmm5-card" and (pw := self._e._session_passphrase()) is not None:
                try: seed_reveal = w.seed_reveal_allowed(self._e.file, pw)
                except w.WalletError: pass
            return {"file": self._e.file, "exists": Path(self._e.file).exists(), "format": fmt, "card": card,
                    "unlocked": self._e.unlocked, "settings": self._e.settings, "identity_index": IDENTITY_INDEX,
                    "version": VERSION, "platform": sys.platform, "card_software": w.card_modules_missing() is None,
                    "selftest": keytool_selftest(), "seed_reveal": seed_reveal}
        return self._wrap(go)

    def set_setting(self, key, value):
        def go():
            if key not in ("theme", "explorer", "hrp", "file"): raise w.WalletError(f"unknown setting {key}")
            if key == "hrp" and value not in ("xpa", "txa"): raise w.WalletError("network must be xpa (mainnet) or txa (testnet)")
            if key == "theme" and value not in ("system", "light", "dark"): raise w.WalletError("theme must be system, light or dark")
            if key in ("file", "hrp"): self._e.lock()
            self._e.settings[key] = value; self._e.save_settings()
            return self._e.settings
        return self._wrap(go)

    def wallets(self):
        def go():
            d = Path.home() / ".xcoin"
            return [str(p) for p in sorted(d.glob("*.mmm"))] if d.exists() else []
        return self._wrap(go)

    def choose_wallet_file(self):
        def go():
            import webview
            picked = self._window.create_file_dialog(webview.FileDialog.OPEN, directory=str(Path.home() / ".xcoin"),
                                                    file_types=("XID wallet (*.mmm)", "All files (*.*)"))
            if not picked: return None
            self._e.lock(); self._e.settings["file"] = picked[0]; self._e.save_settings()
            return picked[0]
        return self._wrap(go)

    # ── wallet lifecycle ──
    def create(self, passphrase, path=None):
        def go():
            if len(passphrase) < 8: raise w.WalletError("use a passphrase of at least 8 characters")
            if path: self._e.settings["file"] = path
            self._e.save_settings()
            made = self._e.run("new", "--offline", passphrase=passphrase, use_backend=False)
            seed = self._e.run("seed", "--yes", passphrase=passphrase, use_backend=False)["seed"]
            self._e.unlock(passphrase)
            return {"file": made["file"], "seed": seed}
        return self._wrap(go)

    def restore(self, seed, passphrase, path=None):
        def go():
            s = "".join(seed.split()).lower()
            if not w._valid_seed(s): raise w.WalletError("that is not a valid seed: 64 hexadecimal characters (0-9, a-f)")
            if len(passphrase) < 8: raise w.WalletError("use a passphrase of at least 8 characters")
            if path: self._e.settings["file"] = path
            self._e.save_settings()
            self._e.run("restore", s, passphrase=passphrase, use_backend=False)
            self._e.unlock(passphrase)
            return {"file": self._e.file}
        return self._wrap(go)

    def unlock(self, passphrase):
        return self._wrap(lambda: (self._e.unlock(passphrase), True)[1])

    def lock(self):
        return self._wrap(lambda: (self._e.lock(), True)[1])

    def reveal_seed(self, passphrase):
        return self._wrap(lambda: self._e.run("seed", "--yes", passphrase=passphrase, use_backend=False)["seed"])

    # ── addresses and identity ──
    def receive(self, index=0):
        def go():
            payment_index(index)
            if not self._e.unlocked or not self._e.pub: raise w.WalletError("The wallet is locked.")
            p = self._e.pub
            return {"address": p["address"], "carried_address": p["carried_address"], "index": 0, "qr": qr_svg(p["address"])}
        return self._wrap(go)

    def identity(self):
        def go():
            if not self._e.unlocked or not self._e.pub: raise w.WalletError("The wallet is locked.")
            return {"identity": self._e.pub["identity"], "index": IDENTITY_INDEX}
        return self._wrap(go)

    def forum_signin(self):
        """Sign in to MineDifferent with the XID identity (key 99,999,999). The forum hands out a challenge; the
        wallet signs its four-line message here (ML-DSA-65, the seed opened for this one signature); the signature
        and public key go back to the forum, which answers with a one-time link that the browser opens to sign in.
        Nothing secret leaves this computer: only the identity, its public key and the signature."""
        def go():
            import urllib.request, webbrowser
            if not self._e.unlocked or not self._e.pub: raise w.WalletError("The wallet is locked.")
            def post(path, body):
                req = urllib.request.Request(FORUM + path, data=json.dumps(body).encode(), method="POST",
                                             headers={"Content-Type": "application/json", "User-Agent": f"XID-Wallet/{VERSION}"})
                try:
                    with urllib.request.urlopen(req, timeout=20) as r: return json.loads(r.read() or b"{}")
                except urllib.error.HTTPError as e:
                    try: why = json.loads(e.read() or b"{}").get("error")
                    except ValueError: why = None
                    raise w.WalletError(f"The forum refused the sign-in: {why or e.reason} ({e.code}).")
                except (urllib.error.URLError, TimeoutError) as e:
                    raise w.WalletError(f"Could not reach {FORUM}: {getattr(e, 'reason', e)}.")
            c = post("/api/challenge/new", {})
            cid, template = c.get("id", ""), c.get("message_template", "")
            if not (len(cid) == 32 and all(ch in "0123456789abcdef" for ch in cid)) or "<your xid1… identity>" not in template:
                raise w.WalletError("The forum sent a sign-in challenge this wallet does not recognise; nothing was signed.")
            signed = self._e.run("signmessage", "--template", template.replace("<your xid1… identity>", "{address}"),
                                 "--index", str(IDENTITY_INDEX), use_backend=False)
            if signed.get("identity") != self._e.pub["identity"]:
                raise w.WalletError("The signature did not come from this wallet's XID identity; nothing was sent.")
            r = post(f"/api/challenge/{cid}/solve", {"address": signed["identity"], "pubkey": signed["pubkey"], "sig": signed["sig"]})
            link = r.get("login_url", "")
            if not r.get("ok") or not link.startswith(FORUM + "/l/"):
                raise w.WalletError("The forum did not return a sign-in link.")
            webbrowser.open(link)
            return {"identity": r.get("identity"), "role": r.get("role"), "badges": r.get("badges")}
        return self._wrap(go)

    # ── chain ──
    def balance(self, index=0):
        def go():
            payment_index(index)
            v = self._e.balance_view()
            f = w.fmt8
            return {"address": self._e.pub["address"], "balance": f(v["balance"]), "spendable": f(v["spendable"]),
                    "confirming": f(v["confirming"]), "immature": f(v["immature"]), "total": f(v["balance"] + v["immature"]),
                    "height": v["height"], "pending": v["pending"], "dropped": v["dropped"]}
        return self._wrap(go)

    def coins(self, index=0):
        """The unspent outputs (what the explorer can list; full history needs a node or the explorer's page)."""
        def go():
            payment_index(index)
            v = self._e.balance_view()
            rows = [{"txid": u["txid"], "vout": u["vout"], "amount": w.fmt8(u["amount"]), "kind": u["kind"], "height": u.get("height"),
                     "confirmations": u["confirmations"], "coinbase": bool(u.get("coinbase")), "spendable": True} for u in v["mature"]]
            rows += [{"txid": u["txid"], "vout": u["vout"], "amount": w.fmt8(u["amount"]), "kind": u["kind"], "height": u.get("height"),
                      "confirmations": u["confirmations"], "coinbase": True, "spendable": False, "blocks_to_maturity": u["blocks_to_maturity"]}
                     for u in v["immature_coins"]]
            rows += [{"txid": c["txid"], "vout": c["vout"], "amount": w.fmt8(w.Decimal(str(c["amount"]))), "kind": "change", "height": None,
                      "confirmations": 0, "coinbase": False, "spendable": False, "confirming": True} for e in v["pending"] for c in e["change_outputs"]]
            return rows
        return self._wrap(go)

    def send_preview(self, destination, amount, index=0):
        def go():
            # --yes skips the CLI's "Type SEND" question, which JSON mode refuses; --dry-run is what keeps it from broadcasting
            idx = payment_index(index)
            v = self._e.balance_view()
            try:
                d = self._e.run("send", destination.strip(), str(amount).strip(), "--index", idx, "--dry-run", "--yes")
            except w.WalletError as e:
                if "insufficient" in str(e) and v["confirming"] > 0:
                    raise w.WalletError(f"{e}. {w.fmt8(v['confirming'])} XID of change from your last send becomes spendable after the next block.")
                raise
            d["balance_before"] = w.fmt8(v["balance"])
            d["balance_after"] = w.fmt8(v["balance"] - w.Decimal(str(amount).strip()) - w.Decimal(str(d.get("fee") or 0)))
            return d
        return self._wrap(go)

    def send(self, destination, amount, index=0):
        def go():
            idx = payment_index(index)
            before = self._e.balance_view()["balance"]
            d = self._e.run("send", destination.strip(), str(amount).strip(), "--index", idx, "--yes")
            if d.get("broadcast"): self._e.record_send(d, str(amount).strip(), destination.strip(), before)
            return d
        return self._wrap(go)

    def add_shortcuts(self):
        """Windows: an "XID Wallet" shortcut on the desktop and in the Start menu, to this folder's XID Wallet.exe."""
        def go():
            import subprocess
            script = Path(__file__).resolve().parent / "shortcuts.ps1"
            if os.name != "nt" or not script.exists(): raise w.WalletError("Shortcuts are made on Windows only.")
            r = subprocess.run(["powershell", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", str(script)],
                               capture_output=True, text=True, timeout=60, creationflags=subprocess.CREATE_NO_WINDOW)
            if r.returncode != 0:
                raise w.WalletError("Could not make the shortcuts: " + ((r.stderr or r.stdout).strip().splitlines() or ["no reason given"])[-1])
            return True
        return self._wrap(go)

    def open_url(self, url):
        """Explorer links open in the system browser; only http(s) links."""
        def go():
            import webbrowser
            if not url.startswith(("https://", "http://")): raise w.WalletError("only web links open from the wallet")
            webbrowser.open(url); return True
        return self._wrap(go)

    def backup(self):
        def go():
            import webview
            ext = Path(self._e.file).suffix or ".mmm"
            picked = self._window.create_file_dialog(webview.FileDialog.SAVE, save_filename=Path(self._e.file).name,
                                                    file_types=(f"XID wallet (*{ext})",))
            if not picked: return None
            return self._e.run("backup", backup_path(picked if isinstance(picked, str) else picked[0], ext), use_backend=False)
        return self._wrap(go)

    # ── NTAG 424 DNA card wallets ──
    def card_create(self, passphrase, label="primary", permanent=False, path=None, allow_seed=False):
        """A one-file card wallet: the card's keys live in the .mmm under the passphrase. Resettable unless
        `permanent` (a sealed card can never be reset or reused). `allow_seed`: the seed may be shown later
        (card + passphrase); False locks it for good. That choice is final. Needs the card on the reader."""
        def go():
            if len(passphrase) < 8: raise w.WalletError("use a passphrase of at least 8 characters")
            before = self._e.settings["file"]
            if path: self._e.settings["file"] = path
            elif Path(self._e.file).exists():
                d = Path(self._e.file).parent
                self._e.settings["file"] = str(next(d / f"card-wallet-{i}.mmm" for i in range(1, 1000) if not (d / f"card-wallet-{i}.mmm").exists()))
            argv = ["new", "--card", "--one-file", "--offline", "--label", (label or "primary")[:32]]
            if not permanent: argv.append("--resettable")
            if allow_seed: argv.append("--allow-seed-reveal")
            try:
                made = self._e.run(*argv, passphrase=passphrase, use_backend=False)
            except Exception:
                self._e.settings["file"] = before   # nothing was made: keep the wallet that was open
                raise
            self._e.save_settings()
            return made
        return self._wrap(go)

    def card_test(self):
        return self._wrap(lambda: self._e.run("card-test", use_backend=False))

    def card_status(self):
        return self._wrap(lambda: self._e.run("card-status", use_backend=False))

    def card_cancel(self):
        """The Cancel button: ends a wait for a card. Once the first write to the new card has begun it is too late
        (a half-written card is worse than none), so the backup then finishes."""
        def go():
            w._card_module().CANCELLED = True
            return True
        return self._wrap(go)

    def card_backup(self, label="backup", permanent=False):
        """Copy this wallet's secret onto another blank card. ANY card already registered in the wallet file can be
        the source (the first card, a backup, a backup of a backup): the new card is registered in the same file, so
        it can in turn make the next one. The wallet must be unlocked (its passphrase guards the card keys).
        The window is told each step, with the seconds the reader waits for it, as window.cardStep({...})."""
        def go():
            cs = w._card_module()
            cs.CANCELLED = False
            waits = [0]

            def push(step, text, seconds=0, writing=False):
                if not self._window: return
                msg = json.dumps({"step": step, "text": text, "seconds": seconds, "writing": writing})
                try: self._window.evaluate_js(f"window.cardStep && window.cardStep({msg})")
                except Exception: pass

            def on_event(name, *parts):
                if name == "card-wait":       # the reader starts waiting: first for the old card, then for the new one
                    waits[0] += 1
                    seconds = int(parts[0]) if parts else cs.card_timeout()
                    if waits[0] == 1: push(1, "Put a card that already opens this wallet on the reader and keep it there.", seconds)
                    else: push(3, "Put a NEW blank card on the reader and keep it there until this finishes.", seconds)
                elif name == "card-swap":
                    push(2, "Card read. Take it off the reader now.", cs.card_timeout())

            begin = w.provisioning_begin
            def begin_checked():              # the commit point: a Cancel that came in before it still stops the run
                if cs.CANCELLED: raise w.WalletError("cancelled")
                push(3, "Writing the new card. Do not move it.", 0, True)
                begin()

            argv = ["card-backup", "--auto-swap", "--label", (label or "backup")[:32]]
            if not permanent: argv.append("--resettable")
            saved = w.event, w.provisioning_begin
            w.event, w.provisioning_begin = on_event, begin_checked
            try: return self._e.run(*argv, use_backend=False)
            finally:
                w.event, w.provisioning_begin = saved
                cs.CANCELLED = False
        return self._wrap(go)

    def card_reset(self):
        def go():
            out = self._e.run("card-reset", "--yes", use_backend=False)
            self._e.lock()
            return out
        return self._wrap(go)

    def copy(self, text):
        """Clipboard through the engine's own helper (pbcopy / clip / xclip)."""
        return self._wrap(lambda: (w.clipboard_copy(text), True)[1])
