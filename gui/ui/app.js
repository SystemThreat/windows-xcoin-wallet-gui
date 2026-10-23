// XID Wallet screens. Every action goes through window.pywebview.api (gui/backend.py), which runs the wallet
// engine's own commands; this file only draws and asks. No network access from the page itself.
(function () {
  "use strict";
  const $app = document.getElementById("app");
  const $toast = document.getElementById("toast");
  const EXPLORER_TX = (base, txid) => `${base.replace(/\/$/, "")}/tx/${txid}`;
  let api = null, S = null, view = "overview", me = null, toastTimer = 0, screen = "";

  // ── helpers ──
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const short = (s, a = 10, b = 8) => (s && s.length > a + b + 1 ? `${s.slice(0, a)}…${s.slice(-b)}` : s || "");
  const h = (html) => { $app.className = ""; $app.innerHTML = html; };
  function toast(msg, kind = "") {
    $toast.textContent = msg; $toast.className = `show ${kind}`;
    clearTimeout(toastTimer); toastTimer = setTimeout(() => ($toast.className = ""), kind === "error" ? 7000 : 3500);
  }
  async function call(name, ...args) {
    const r = await api[name](...args);
    if (r && r.error) throw new Error(r.error);
    return r ? r.ok : null;
  }
  async function busy(btn, fn, working = "Working…") {
    const label = btn.innerHTML; btn.disabled = true; btn.classList.add("busy"); btn.innerHTML = working;
    try { return await fn(); } catch (e) { relock(e); } finally { btn.disabled = false; btn.classList.remove("busy"); btn.innerHTML = label; if (btn._gate) btn._gate(); }
  }
  // a button that stays gray until its condition holds (a passphrase typed, a box ticked), then turns solid
  function gate(btn, ready) { const sync = () => (btn.disabled = !ready()); btn._gate = sync; sync(); return sync; }
  const XID_MARK = '<svg viewBox="0 0 1024 1024" aria-hidden="true"><rect width="1024" height="1024" fill="#c7ff2e"/><path d="M763 782H631.5L511.8 595.2 391.7 782H261L422.7 535.2H322.5v-68.5h101.3L278.3 242h127.4L514 415.5 620.1 242h126.4L602.4 466.7h99.9v68.5H599.1Z" fill="#0b0b0b"/></svg>';

  // ── theme ──
  function applyTheme(pref) {
    if (pref === "light" || pref === "dark") document.documentElement.dataset.theme = pref;
    else delete document.documentElement.dataset.theme;
  }
  const isNight = () => document.documentElement.dataset.theme ? document.documentElement.dataset.theme === "dark" : window.matchMedia("(prefers-color-scheme: dark)").matches;

  // ── boot ──
  async function boot() {
    api = window.pywebview.api;
    S = await call("state");
    applyTheme(S.settings.theme);
    if (S.selftest !== "ok") return broken(S.selftest);
    if (!S.exists) return welcome();
    if (!S.unlocked) return unlock();
    return shell();
  }
  window.addEventListener("pywebviewready", () => boot().catch((e) => toast(e.message, "error")));

  function broken(why) {
    h(`<div class="welcome"><section class="welcome-art"><span class="label">Stopped</span><div><h1 class="display">Do not<br>use this build</h1>
      <p style="margin-top:18px">The signing tool did not pass its self-test, so this copy of the wallet must not sign anything.</p></div><span></span></section>
      <section class="welcome-side"><h2 class="display">What happened</h2><p class="mono selectable" style="word-break:break-word">${esc(why)}</p>
      <p class="note">Get a fresh copy of XID Wallet and check its SHA-256 against the published one. Your wallet file and seed are untouched.</p></section></div>`);
  }

  // ── welcome: no wallet yet ──
  function welcome() {
    h(`<div class="welcome">
      <section class="welcome-art">
        <span class="label">xCoin · XID</span>
        <div><h1 class="display">XID<br>Wallet</h1><p style="margin-top:18px">Post-quantum money. Your keys are made here and never leave this computer.</p></div>
        <div class="facts"><span>ML-DSA-65 signatures</span><span>100,000,000 XID cap</span><span>No premine</span></div>
      </section>
      <section class="welcome-side">
        <h2 class="display">Get started</h2>
        <button class="choice box lime" data-go="create"><b>Create a new wallet</b><span>A fresh seed, encrypted with your passphrase.</span></button>
        <button class="choice box" data-go="restore"><b>Restore from a seed</b><span>You have the 64-character seed written down.</span></button>
        <button class="choice box" data-go="open"><b>Open a wallet file</b><span>A .mmm file from the command-line wallet or a backup.</span></button>
        <button class="choice box" data-go="card"${S.card_software ? "" : " disabled"}><b>Card wallet</b><span>${S.card_software ? "An NTAG 424 DNA card is the key: tap it to unlock and to sign. Needs a USB card reader." : "Card software is not in this copy of the app."}</span></button>
      </section></div>`);
    $app.querySelector('[data-go="create"]').onclick = createWallet;
    $app.querySelector('[data-go="restore"]').onclick = restoreWallet;
    const cardBtn = $app.querySelector('[data-go="card"]'); if (cardBtn && !cardBtn.disabled) cardBtn.onclick = cardWallet;
    $app.querySelector('[data-go="open"]').onclick = async () => { try { if (await call("choose_wallet_file")) { S = await call("state"); unlock(); } } catch (e) { toast(e.message, "error"); } };
  }

  function passFields() {
    return `<label class="field"><span>Passphrase</span><input type="password" name="pw" autocomplete="new-password" minlength="8" required>
      <span class="hint">At least 8 characters. It encrypts the wallet file on this computer; the seed is still your backup.</span></label>
      <label class="field"><span>Confirm passphrase</span><input type="password" name="pw2" autocomplete="new-password" required></label>`;
  }
  function checkPass(f) {
    if (f.pw.value.length < 8) { toast("Use a passphrase of at least 8 characters.", "error"); return false; }
    if (f.pw.value !== f.pw2.value) { toast("The two passphrases are different.", "error"); return false; }
    return true;
  }

  function createWallet() {
    h(`<div class="welcome"><section class="welcome-art"><span class="label">New wallet</span><div><h1 class="display">A new<br>seed</h1>
      <p style="margin-top:18px">The seed is made on this computer from the system's random source and saved encrypted. Next you write it down.</p></div><span></span></section>
      <section class="welcome-side"><button class="link back">← Back</button><h2 class="display">Choose a passphrase</h2>
      <form class="stack" autocomplete="off">${passFields()}<button class="btn primary" type="submit">Create wallet →</button></form></section></div>`);
    $app.querySelector(".back").onclick = welcome;
    const f = $app.querySelector("form");
    f.onsubmit = (ev) => { ev.preventDefault(); if (!checkPass(f)) return;
      busy(f.querySelector("button"), async () => { const r = await call("create", f.pw.value); f.reset(); S = await call("state"); backupSeed(r.seed); }); };
    f.pw.focus();
  }

  // the seed, shown once, then two of its groups typed back
  function backupSeed(seed) {
    const groups = seed.match(/.{8}/g);
    const ask = [2, 5].map((i) => i + Math.floor(Math.random() * 2));
    h(`<div class="page" style="max-width:860px;margin:0 auto;overflow-y:auto;height:100%">
      <div class="page-head"><h1 class="display">Write down your seed</h1></div>
      <p class="warn">This seed is the only way to get your XID back if this computer or the passphrase is lost. Write it on paper or metal, keep it offline, and never type it into a website or a chat.</p>
      <div class="seed-grid selectable">${groups.map((g, i) => `<div><i>${String(i + 1).padStart(2, "0")}</i><b>${g}</b></div>`).join("")}</div>
      <form class="box stack" style="padding:20px" autocomplete="off">
        <p>Type groups <b>${ask[0] + 1}</b> and <b>${ask[1] + 1}</b> from your copy to show you wrote it down.</p>
        <div class="row"><label class="field" style="flex:1"><span>Group ${ask[0] + 1}</span><input name="a" maxlength="8" spellcheck="false"></label>
          <label class="field" style="flex:1"><span>Group ${ask[1] + 1}</span><input name="b" maxlength="8" spellcheck="false"></label></div>
        <label class="check"><input type="checkbox" name="ok"> I wrote the seed down offline and I understand nobody can recover it for me.</label>
        <button class="btn primary" type="submit">Open my wallet →</button></form></div>`);
    const f = $app.querySelector("form");
    f.onsubmit = (ev) => { ev.preventDefault();
      if (f.a.value.trim().toLowerCase() !== groups[ask[0]] || f.b.value.trim().toLowerCase() !== groups[ask[1]]) return toast("Those groups do not match the seed. Check your copy.", "error");
      if (!f.ok.checked) return toast("Tick the box once the seed is written down.", "error");
      shell(); };
  }

  function restoreWallet() {
    h(`<div class="welcome"><section class="welcome-art"><span class="label">Restore</span><div><h1 class="display">Bring your<br>XID back</h1>
      <p style="margin-top:18px">Your seed recreates every address and the XID identity. The new wallet file is encrypted with the passphrase you choose.</p></div><span></span></section>
      <section class="welcome-side"><button class="link back">← Back</button><h2 class="display">Your seed</h2>
      <form class="stack" autocomplete="off"><label class="field"><span>Seed (64 characters, 0-9 and a-f)</span><textarea name="seed" spellcheck="false" autocomplete="off"></textarea>
      <span class="hint">Spaces and line breaks are ignored.</span></label>${passFields()}<button class="btn primary" type="submit">Restore wallet →</button></form></section></div>`);
    $app.querySelector(".back").onclick = welcome;
    const f = $app.querySelector("form");
    f.onsubmit = (ev) => { ev.preventDefault(); if (!checkPass(f)) return;
      busy(f.querySelector("button"), async () => { await call("restore", f.seed.value, f.pw.value); f.reset(); S = await call("state"); toast("Wallet restored.", "ok"); shell(); }); };
  }

  function cardWallet() {
    h(`<div class="welcome"><section class="welcome-art"><span class="label">Card wallet</span><div><h1 class="display">The card<br>is the key</h1>
      <p style="margin-top:18px">A random secret is written into the NTAG 424 DNA chip over an encrypted channel. Your wallet opens only with this file, the card and the passphrase together. The seed is never shown.</p></div>
      <div class="facts"><span>NXP NTAG 424 DNA</span><span>AES EV2</span><span>One file</span></div></section>
      <section class="welcome-side"><button class="link back">← Back</button><h2 class="display">Set up the card</h2>
      <form class="stack" autocomplete="off">
        <div class="choice"><p class="warn"><b>Choose carefully. This choice is final.</b> It is made once, now, and nothing in this app or the command line can change it later.</p>
          <label class="opt"><input type="radio" name="seedmode" value="never" required><b>Never show the seed (maximum security)</b>
            <span class="d">The seed is not shown now and never will be. Not to you, not to anyone who gets your wallet file, your card and your passphrase. There is no seed to write down, and nobody can trick you into reading it out. The wallet lives only in the file, a card and the passphrase. Lose all your cards, or the file, or the passphrase, and the funds are gone for good, so make backup cards right away and keep copies of the file.</span></label>
          <label class="opt"><input type="radio" name="seedmode" value="allow" required><b>Allow showing the seed later</b>
            <span class="d">In Settings you can show the seed, with the file, a card and the passphrase. You can write it down and restore the wallet without any card. The cost: anyone who gets all three can show it too, and a written copy can be stolen or leaked.</span></label>
          <p class="note">How strong is "never"? It is a lock built into the file and this app, not a law of mathematics: the app still opens the seed in memory to sign payments. It means no screen, button or command will ever show it.</p>
        </div>
        <label class="field"><span>Card label</span><input name="label" value="primary" maxlength="32"></label>
        ${passFields()}
        <label class="check"><input type="checkbox" name="seal"> Seal the card permanently. A sealed card can never be reset or reused. Leave this off while testing.</label>
        <p class="warn"><b>1.</b> Plug in the card reader and put a blank card on it.<br><b>2.</b> Fill in the passphrase above.<br><b>3.</b> Press Write the card. Do not press it until the card is on the reader, and keep it there until the wallet is made.</p>
        <button class="btn primary" type="submit">Write the card →</button></form></section></div>`);
    $app.querySelector(".back").onclick = welcome;
    const f = $app.querySelector("form");
    f.onsubmit = (ev) => { ev.preventDefault(); if (!checkPass(f)) return;
      const allow = f.seedmode.value === "allow";
      if (!confirm(allow
        ? "FINAL CHOICE: you can show the seed later.\n\nAnyone who gets the wallet file, a card and your passphrase will be able to show it too. This can never be changed.\n\nContinue?"
        : "FINAL CHOICE: the seed will NEVER be shown.\n\nIf you lose every card, or the wallet file, or the passphrase, the funds are lost for good: there is no seed to restore from. This can never be changed.\n\nContinue?")) return;
      if (f.seal.checked && !confirm("Seal this card permanently? It can never be reset or reused.")) return;
      toast("Hold the card on the reader…");
      busy(f.querySelector("button"), async () => {
        const r = await call("card_create", f.pw.value, f.label.value.trim() || "primary", f.seal.checked, null, allow);
        f.reset(); S = await call("state");
        toast(`Card ${r.card_uid} is ready${r.permanent ? " and sealed" : ""}. Tap it again to open the wallet.`, "ok");
        unlock();
      }); };
  }

  function unlock() {
    screen = "unlock";
    h(`<div class="welcome"><section class="welcome-art"><span class="label">Locked</span><div><h1 class="display">XID<br>Wallet</h1>
      <p style="margin-top:18px">Unlock to see your balance and send. The wallet locks itself after ten minutes without use.</p></div>
      <div class="facts"><span>${esc(S.settings.hrp === "xpa" ? "Mainnet" : "Testnet")}</span><span>${esc(S.settings.explorer.replace(/^https?:\/\//, ""))}</span></div></section>
      <section class="welcome-side"><h2 class="display">Unlock</h2>
      <form class="stack" autocomplete="off"><p class="note selectable mono" style="word-break:break-all">${esc(S.file)}</p>
      ${S.card ? '<p class="warn"><b>1.</b> Put your card on the reader and leave it there.<br><b>2.</b> Type your passphrase.<br><b>3.</b> Press Unlock. Do not press it until the card is on the reader.</p>' : ""}
      <label class="field"><span>Passphrase</span><input type="password" name="pw" autocomplete="current-password" ${S.card ? "" : "required"}></label>
      <button class="btn primary" type="submit">${S.card ? "Unlock with card →" : "Unlock →"}</button></form>
      <div class="row"><button class="link" data-act="other">Open another wallet file</button><button class="link" data-act="new">New or restored wallet</button></div></section></div>`);
    const f = $app.querySelector("form");
    f.onsubmit = (ev) => { ev.preventDefault(); if (S.card) toast("Keep the card on the reader until the wallet opens…"); busy(f.querySelector("button"), async () => { await call("unlock", f.pw.value); f.reset(); S = await call("state"); shell(); }); };
    $app.querySelector('[data-act="other"]').onclick = async () => { try { if (await call("choose_wallet_file")) { S = await call("state"); unlock(); } } catch (e) { toast(e.message, "error"); } };
    $app.querySelector('[data-act="new"]').onclick = async () => {
      const p = await call("set_setting", "file", S.file.replace(/[^\\/]+$/, `wallet-${Date.now().toString(36)}.mmm`)); S = await call("state"); welcome(); };
    f.pw.focus();
  }

  // ── the wallet ──
  const NAV = [["overview", "Overview"], ["receive", "Receive"], ["send", "Send"], ["coins", "Coins"], ["identity", "Identity"], ["settings", "Settings"]];
  async function shell() {
    screen = "shell";
    h(`<div class="shell"><aside class="side">
        <div class="brand">${XID_MARK}<div><b>XID Wallet</b><span class="net">${S.settings.hrp === "xpa" ? "Mainnet" : "Testnet"} · v${esc(S.version)}</span></div></div>
        <nav class="nav">${NAV.map(([k, t]) => `<button data-v="${k}">${t}</button>`).join("")}</nav>
        <div class="side-foot">
          <button class="me" data-v="identity" title="Your XID identity"><span class="ic"></span><span><small>XID identity</small><code>…</code></span></button>
          <button class="mode" title="Day or night"><span data-m="day">Day</span><span data-m="night">Night</span></button>
          <button class="btn small" data-act="lock">Lock wallet</button>
        </div></aside><main class="main"><div class="page" id="page"></div></main></div>`);
    $app.querySelectorAll("[data-v]").forEach((b) => (b.onclick = () => go(b.dataset.v)));
    $app.querySelector('[data-act="lock"]').onclick = async () => { await call("lock"); S = await call("state"); unlock(); };
    const mode = $app.querySelector(".mode");
    const paintMode = () => { mode.querySelector('[data-m="day"]').classList.toggle("on", !isNight()); mode.querySelector('[data-m="night"]').classList.toggle("on", isNight()); };
    mode.onclick = async () => { const next = isNight() ? "light" : "dark"; applyTheme(next); paintMode(); try { S.settings = await call("set_setting", "theme", next); } catch (e) { toast(e.message, "error"); } };
    window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", paintMode);
    paintMode();
    loadIdentity();
    go(view);
  }
  async function loadIdentity() {
    try {
      me = await call("identity");
      const el = $app.querySelector(".me"); if (!el) return;
      el.querySelector("code").textContent = short(me.identity, 9, 6);
      el.querySelector(".ic").innerHTML = await identiconSvg(me.identity, 40);
    } catch (e) { relock(e); }
  }
  function relock(e) {
    if (/locked/i.test(e.message)) {
      if (screen === "unlock") return true;   // already locked by hand: a late answer from before the lock says nothing new
      call("state").then((s) => { S = s; unlock(); toast("The wallet locked itself. Unlock to continue."); }); return true;
    }
    toast(e.message, "error"); return false;
  }
  function go(v) {
    view = v; clearTimeout(refreshTimer);
    $app.querySelectorAll(".nav button").forEach((b) => b.classList.toggle("on", b.dataset.v === v));
    ({ overview, receive, send, coins, identity, settings }[v] || overview)();
  }
  const page = (html) => { const p = document.getElementById("page"); p.innerHTML = html; p.parentElement.scrollTop = 0; return p; };
  const head = (title, right = "") => `<div class="page-head"><h1 class="display">${title}</h1><div class="row">${right}</div></div>`;

  let refreshTimer = 0;
  async function overview() {
    clearTimeout(refreshTimer);
    const p = page(`${head("Overview", '<button class="btn small" data-act="refresh">Refresh</button>')}
      <section class="box balance"><div class="balance-main"><div class="row"><span class="label">Balance</span><span class="chip confirming" hidden>Confirming</span></div>
        <div class="amt"><b>…</b><span>XID</span></div><p class="bal-note" hidden></p></div>
      <dl class="stats"><div><dt>Available now</dt><dd data-k="spendable">…</dd></div><div><dt>Confirming</dt><dd data-k="confirming">…</dd></div>
        <div><dt>Mined, maturing</dt><dd data-k="immature">…</dd></div><div><dt>Block height</dt><dd data-k="height">…</dd></div></dl></section>
      <div id="pending" class="stack"></div>
      <section class="box addr-strip"><span class="label">Address</span><span class="addr" data-k="address">…</span><button class="btn small" data-act="copy">Copy</button></section>
      <p class="note">Your balance is what you have after your sends: right after you send, it already shows the result (before minus sent minus fee), and it becomes final when the next block confirms the transaction, about five minutes. Mined coins become spendable after 1,000 blocks. Balances come from ${esc(S.settings.explorer.replace(/^https?:\/\//, ""))}; your keys and signing stay on this computer.</p>`);
    p.querySelector('[data-act="refresh"]').onclick = overview;
    try {
      const b = await call("balance", 0);
      p.querySelector(".amt b").textContent = b.balance;
      for (const k of ["spendable", "confirming", "immature"]) p.querySelector(`[data-k="${k}"]`).textContent = b[k];
      p.querySelector('[data-k="height"]').textContent = b.height != null ? Number(b.height).toLocaleString() : "–";
      p.querySelector('[data-k="address"]').textContent = b.address;
      p.querySelector('[data-act="copy"]').onclick = () => copy(b.address, "Address copied.");
      const pend = p.querySelector("#pending");
      if (b.pending.length) {
        p.querySelector(".chip.confirming").hidden = false;
        const note = p.querySelector(".bal-note"); note.hidden = false;
        note.textContent = `Includes ${b.confirming} XID of change on its way back. Final with the next block.`;
        pend.innerHTML = b.pending.map((e) => `<section class="box pending"><span class="label">Confirming with the next block</span>
          <p>You sent <b>${esc(e.amount)} XID</b> to <span class="mono">${esc(short(e.to, 12, 6))}</span>.</p>
          <div class="math"><div><b>${esc(e.before)}</b><i>before</i></div><span>−</span><div><b>${esc(e.amount)}</b><i>sent</i></div><span>−</span>
            <div><b>${esc(e.fee)}</b><i>fee</i></div><span>=</span><div class="res"><b>${esc(e.after)}</b><i>now</i></div></div>
          <div><button class="link" data-tx="${esc(e.txids[0])}">View the transaction</button></div></section>`).join("");
        pend.querySelectorAll("[data-tx]").forEach((el) => (el.onclick = () => call("open_url", EXPLORER_TX(S.settings.explorer, el.dataset.tx)).catch((er) => toast(er.message, "error"))));
        refreshTimer = setTimeout(() => { if (view === "overview" && document.getElementById("pending")) overview(); }, 30000);
      }
      if (b.dropped.length) pend.insertAdjacentHTML("beforeend", b.dropped.map((e) => `<p class="warn">Your send of ${esc(e.amount)} XID did not confirm, so its coins count in your balance again. Check the explorer before sending again.</p>`).join(""));
    } catch (e) {
      if (relock(e)) return;
      p.querySelector(".balance").outerHTML = `<div class="error-panel"><b>Balance unavailable</b><p>${esc(e.message)}</p><div><button class="btn small" data-act="retry">Try again</button></div></div>`;
      p.querySelector('[data-act="retry"]').onclick = overview;
    }
  }
  async function copy(text, done) { try { await call("copy", text); toast(done, "ok"); } catch (e) { toast(e.message, "error"); } }

  async function receive() {
    const p = page(`${head("Receive")}<section class="box receive"><div class="qr">…</div><div class="receive-info">
      <span class="label">Your XID address</span><p class="addr selectable">…</p><div class="row"><button class="btn primary" data-act="copy">Copy address</button></div>
      <p class="note">Share this address to receive XID. It is a witness v3 address: payments to it are protected by ML-DSA-65, with an SLH-DSA-SHA2-128s fallback key.</p>
      <details class="more"><summary>Older single-leaf form</summary><p class="note">Coins sent to the single-leaf form of the same key are also yours and show in your balance:</p><p class="addr selectable" data-k="carried"></p></details>
      </div></section>`);
    try {
      const r = await call("receive", 0);
      p.querySelector(".qr").innerHTML = r.qr;
      p.querySelector(".receive-info .addr").textContent = r.address;
      p.querySelector('[data-k="carried"]').textContent = r.carried_address;
      p.querySelector('[data-act="copy"]').onclick = () => copy(r.address, "Address copied.");
    } catch (e) { relock(e); }
  }

  function send() {
    const p = page(`${head("Send")}<div class="send"><form class="box" autocomplete="off">
        <label class="field"><span>To (XID address)</span><input name="to" spellcheck="false" placeholder="${S.settings.hrp}1r…" required></label>
        <label class="field"><span>Amount</span><div class="amount-wrap"><input name="amount" inputmode="decimal" placeholder="0.00000000" required><b>XID</b></div></label>
        <button class="btn primary" type="submit">Review →</button>
        <p class="note">Review signs the transaction on this computer and checks it with the network. Nothing is sent until you press Send.${S.card ? " Card wallet: keep your card on the reader for Review and for Send." : ""}</p>
      </form><section class="box review" id="review" hidden></section></div>`);
    const f = p.querySelector("form"), rv = p.querySelector("#review");
    f.onsubmit = (ev) => { ev.preventDefault();
      busy(f.querySelector("button"), async () => {
        const to = f.to.value.trim(), amount = f.amount.value.trim();
        const d = await call("send_preview", to, amount, 0);
        rv.hidden = false; rv.classList.remove("sent");
        rv.innerHTML = `<h3>Check before sending</h3><dl>
          <div><dt>To</dt><dd class="selectable">${esc(to)}</dd></div><div><dt>Amount</dt><dd>${esc(amount)} XID</dd></div>
          <div><dt>Network fee</dt><dd>${esc(d.fee)} XID</dd></div><div><dt>Change back to you</dt><dd>${esc(d.change)} XID</dd></div>
          <div><dt>Size</dt><dd>${esc(d.vsize)} vB · ${esc(d.inputs)} input${d.inputs === 1 ? "" : "s"}</dd></div>
          <div class="total"><dt>Total leaving</dt><dd>${(Number(amount) + Number(d.fee)).toFixed(8)} XID</dd></div>
          <div><dt>Balance now</dt><dd>${esc(d.balance_before)} XID</dd></div>
          <div class="total"><dt>Balance after this send</dt><dd>${esc(d.balance_after)} XID</dd></div></dl>
          <div class="actions">${d.mempool_accept === false ? `<p class="warn">The network would refuse this transaction: ${esc(d.reject_reason || "unknown reason")}</p>` : ""}
          <label class="check"><input type="checkbox" name="sure"> Send ${esc(amount)} XID to this address. Sent XID cannot be called back.</label>
          <button class="btn danger" data-act="send" disabled>Send now</button></div>`;
        const sure = rv.querySelector('[name="sure"]'), sendBtn = rv.querySelector('[data-act="send"]');
        sure.addEventListener("change", gate(sendBtn, () => sure.checked));
        sendBtn.onclick = (e2) => {
          if (!sure.checked) return;
          busy(e2.currentTarget, async () => {
            const s = await call("send", to, amount, 0);
            rv.classList.add("sent");
            rv.innerHTML = `<h3>Sent</h3><dl><div><dt>Amount</dt><dd>${esc(amount)} XID</dd></div><div><dt>Fee</dt><dd>${esc(s.fee)} XID</dd></div>
              <div><dt>Transaction</dt><dd class="selectable">${esc(s.txid)}</dd></div></dl>
              <div class="actions"><p class="note" style="color:inherit">Your balance already shows the result. It is final once the next block confirms it, about five minutes.</p>
              <div class="row"><button class="btn" data-act="view">View on the explorer</button><button class="btn" data-act="home">See my balance</button></div></div>`;
            rv.querySelector('[data-act="home"]').onclick = () => go("overview");
            rv.querySelector('[data-act="view"]').onclick = () => call("open_url", EXPLORER_TX(S.settings.explorer, s.txid)).catch((e) => toast(e.message, "error"));
            f.reset(); toast("Sent. It confirms in the next blocks.", "ok");
          }, S.card ? "Tap the card… sending" : "Signing and sending…");
        };
      }, S.card ? "Tap the card… checking" : "Checking and signing…").catch(() => {});
    };
  }

  async function coins() {
    const p = page(`${head("Coins", '<button class="btn small" data-act="explorer">Full history on the explorer</button>')}<div id="coins">Loading…</div>
      <p class="note">These are the coins your address holds right now. The full list of past payments is on the explorer's address page.</p>`);
    try {
      const rows = await call("coins", 0);
      const r0 = await call("receive", 0);
      p.querySelector('[data-act="explorer"]').onclick = () => call("open_url", `${S.settings.explorer.replace(/\/$/, "")}/address/${r0.address}`).catch((e) => toast(e.message, "error"));
      p.querySelector("#coins").innerHTML = rows.length ? `<table class="coins"><thead><tr><th>Transaction</th><th>Height</th><th>Confirmations</th><th>Kind</th><th style="text-align:right">Amount</th></tr></thead><tbody>
        ${rows.map((u) => `<tr><td class="selectable">${esc(short(u.txid, 12, 6))}:${u.vout}</td><td>${esc(u.height ?? "–")}</td><td>${esc(u.confirmations)}</td>
          <td>${u.confirming ? '<span class="chip">Change, confirming</span>' : `${u.coinbase ? '<span class="chip">Mined</span> ' : ""}${u.spendable ? '<span class="chip lime">Spendable</span>' : `<span class="chip">${esc(u.blocks_to_maturity)} blocks to go</span>`}`}</td>
          <td class="num">${esc(u.amount)}</td></tr>`).join("")}</tbody></table>` : '<div class="box empty"><p>No coins yet. Share your address from Receive.</p></div>';
    } catch (e) { relock(e); }
  }

  async function identity() {
    const p = page(`${head("Identity")}<section class="box identity"><div class="ic-big"></div><div class="identity-info">
      <span class="label">Your XID identity</span><h3>Key number 100,000,000</h3><p class="addr selectable">…</p>
      <div class="row"><button class="btn primary" data-act="copy">Copy identity</button><button class="btn" data-act="forum">Sign in to MineDifferent</button></div>
      <p class="note" data-forum hidden></p>
      <p class="note">This is your public name on xCoin: for chat, AYEDEX and signing messages. It comes from key index 99,999,999 of your seed and nothing can be paid to it. It cannot be traced to your balance: your funds are on index 0, and every key is derived from the seed on its own.</p>
      <p class="note">The mark on the left is drawn from the identity itself, the same mark MMM, superknet.com and the forum show.</p></div></section>`);
    try {
      me = me || await call("identity");
      p.querySelector(".identity-info .addr").textContent = me.identity;
      p.querySelector(".ic-big").innerHTML = await identiconSvg(me.identity, 240);
      p.querySelector('[data-act="copy"]').onclick = () => copy(me.identity, "Identity copied.");
      const forum = p.querySelector('[data-act="forum"]'), note = p.querySelector("[data-forum]");
      forum.onclick = () => busy(forum, async () => {
        const r = await call("forum_signin");   // signs the forum's challenge with key 99,999,999 here, then opens the browser
        note.hidden = false;
        note.textContent = `Signed in to minedifferent.com${r.role === "founder" ? " as founder" : ""}. Your browser opened the one-time sign-in link; finish there.`;
        toast("Signed in. Check your browser.", "good");
      }, "Signing…");
    } catch (e) { relock(e); }
  }

  function settings() {
    const st = S.settings;
    const seg = (key, opts) => `<div class="seg" data-key="${key}">${opts.map(([v, t]) => `<button data-val="${v}" class="${st[key] === v ? "on" : ""}">${t}</button>`).join("")}</div>`;
    const p = page(`${head("Settings")}<section class="box settings">
      <div class="set-row"><h3>Look</h3><div class="stack">${seg("theme", [["system", "System"], ["light", "Day"], ["dark", "Night"]])}<p class="note">System follows Windows' light or dark setting.</p></div></div>
      <div class="set-row"><h3>Network</h3><div class="stack">${seg("hrp", [["xpa", "Mainnet"], ["txa", "Testnet"]])}<p class="note">Mainnet addresses start xpa1r, testnet txa1r.</p></div></div>
      <div class="set-row"><h3>Explorer</h3><form class="stack" data-f="explorer"><label class="field"><span>Balances, fees and sending go through</span><input name="url" value="${esc(st.explorer)}" spellcheck="false"></label>
        <div><button class="btn small" type="submit">Save</button></div><p class="note">The explorer only reports the chain and passes on signed transactions. It never sees your keys.</p></form></div>
      <div class="set-row"><h3>Wallet file</h3><div class="stack"><p class="addr selectable">${esc(S.file)}</p><div class="row"><button class="btn small" data-act="backup">Back up the file</button><button class="btn small" data-act="other">Open another</button></div>
        <p class="note">The file is encrypted with your passphrase. Keep a copy on a USB stick; your written seed is the backup that needs no passphrase.</p></div></div>
      ${S.card ? `<div class="set-row"><h3>Card</h3><div class="stack"><div class="row"><button class="btn small" data-act="card-test">Test the card</button><button class="btn small" data-act="card-status">Cards for this wallet</button><button class="btn small danger" data-act="card-reset">Reset the card</button></div>
        <p class="note"><b>Put the card on the reader before you press Test or Reset.</b> The reader waits 60 seconds for a card.</p>
        <section class="bk" data-k="bk"><h4>Backup card</h4>
          <p class="note">Copies this wallet onto another blank card. Any card that already opens this wallet can be the source, including another backup, so the second card can make a third if the first is lost.</p>
          <div class="bk-idle"><label class="check"><input type="checkbox" data-k="bk-seal"><span>Seal the backup card permanently</span></label><button class="btn small" data-act="card-backup">Make a backup card</button></div>
          <div class="flow" data-k="flow" hidden>
            <span class="flow-step" data-k="flow-step"></span><span class="flow-clock" data-k="flow-clock"></span>
            <span class="flow-msg" data-k="flow-msg"></span><button class="btn small" data-act="card-cancel">Cancel</button>
            <span class="flow-bar"><i data-k="flow-bar"></i></span></div>
          <p class="note">Each new card is added to the wallet file: copy the file again afterwards, and keep the cards in separate places.</p></section>
        <pre class="note mono selectable" data-k="card-out" style="white-space:pre-wrap;margin:0"></pre>
        <p class="note">Test reads the card over its encrypted channel without changing it. Reset returns a resettable card to its factory keys, which makes this wallet unopenable: only for test cards holding no XID.</p></div></div>` : ""}
      ${S.card && S.seed_reveal === false ? `<div class="set-row"><h3>Seed</h3><div class="stack"><p class="warn"><b>Locked for good.</b> This wallet was created with the choice never to show the seed. That choice is final: nothing can show it, and there is no seed to write down.</p>
        <p class="note">Your wallet is the file, a card and the passphrase. Make backup cards (Card section above) and keep copies of the wallet file in separate places.</p></div></div>` :
      `<div class="set-row"><h3>Seed</h3><form class="stack" data-f="seed" autocomplete="off">${S.card ? '<p class="warn">Put your card on the reader first, then type the passphrase and press Show seed.</p>' : ""}<label class="field"><span>Passphrase, to show the seed</span><input type="password" name="pw" autocomplete="current-password"></label>
        <div><button class="btn small danger" type="submit" disabled>Show seed</button></div><div class="seed-reveal"></div></form></div>`}
      ${S.platform === "win32" ? `<div class="set-row"><h3>Shortcuts</h3><div class="stack"><div><button class="btn small" data-act="shortcuts">Add to desktop and Start menu</button></div>
        <p class="note">Puts an XID Wallet icon on the desktop and in the Start menu. If you move the XID Wallet folder, press it again.</p></div></div>` : ""}
      <div class="set-row"><h3>About</h3><p class="note">XID Wallet ${esc(S.version)}. Open source, MIT licence. The wallet engine is the xcoin-wallet command-line wallet; signatures are ML-DSA-65 (FIPS 204) with an SLH-DSA-SHA2-128s (FIPS 205) fallback.</p></div>
    </section>`);
    p.querySelectorAll(".seg").forEach((g) => g.querySelectorAll("button").forEach((b) => (b.onclick = async () => {
      try {
        S.settings = await call("set_setting", g.dataset.key, b.dataset.val);
        if (g.dataset.key === "theme") applyTheme(b.dataset.val);
        if (g.dataset.key === "hrp") { me = null; S = await call("state"); return shell(); }
        settings();
      } catch (e) { toast(e.message, "error"); }
    })));
    p.querySelector('[data-f="explorer"]').onsubmit = async (ev) => { ev.preventDefault();
      try { S.settings = await call("set_setting", "explorer", ev.target.url.value.trim()); toast("Explorer saved.", "ok"); } catch (e) { toast(e.message, "error"); } };
    p.querySelector('[data-act="backup"]').onclick = async () => { try { const r = await call("backup"); if (r) toast(`Backed up to ${r.backup}`, "ok"); } catch (e) { toast(e.message, "error"); } };
    p.querySelector('[data-act="other"]').onclick = async () => { try { if (await call("choose_wallet_file")) { S = await call("state"); unlock(); } } catch (e) { toast(e.message, "error"); } };
    const sc = p.querySelector('[data-act="shortcuts"]');
    if (sc) sc.onclick = (ev) => busy(ev.currentTarget, async () => { await call("add_shortcuts"); toast("XID Wallet is on the desktop and in the Start menu.", "ok"); });
    if (S.card) {
      const out = p.querySelector('[data-k="card-out"]');
      const show = (v) => (out.textContent = JSON.stringify(v, null, 2));
      p.querySelector('[data-act="card-test"]').onclick = (ev) => { toast("Hold the card on the reader…"); busy(ev.currentTarget, async () => { show(await call("card_test")); toast("The card answered correctly.", "ok"); }); };
      p.querySelector('[data-act="card-status"]').onclick = (ev) => busy(ev.currentTarget, async () => show(await call("card_status")));
      const q = (k) => p.querySelector(`[data-k="${k}"]`);
      const sealBox = q("bk-seal"), flow = q("flow"), cancelBtn = p.querySelector('[data-act="card-cancel"]');
      const others = p.querySelectorAll('[data-act="card-test"], [data-act="card-status"], [data-act="card-reset"]');
      let clock = null, cancelled = false;
      // while a backup runs: the seal box and the other card buttons are gray, the step panel with Cancel is shown
      const running = (on) => {
        sealBox.disabled = on; sealBox.closest(".check").classList.toggle("off", on);
        others.forEach((b) => (b.disabled = on)); flow.hidden = !on;
      };
      const count = (secs) => {
        clearInterval(clock);
        const end = Date.now() + secs * 1000;
        const draw = () => {
          const left = Math.max(0, Math.ceil((end - Date.now()) / 1000));
          q("flow-clock").textContent = `${left}s`; q("flow-bar").style.width = `${(left / secs) * 100}%`;
          if (!left) clearInterval(clock);
        };
        draw(); clock = setInterval(draw, 250);
      };
      // the engine's steps arrive here: {step, text, seconds, writing}
      const stepTo = (s) => {
        q("flow-step").textContent = `Step ${s.step} of 3`; q("flow-msg").textContent = s.text;
        if (s.seconds) count(s.seconds); else { clearInterval(clock); q("flow-clock").textContent = ""; q("flow-bar").style.width = "100%"; }
        cancelBtn.disabled = !!s.writing || cancelled;
      };
      cancelBtn.onclick = async () => {
        cancelled = true; cancelBtn.disabled = true; q("flow-msg").textContent = "Cancelling…";
        try { await call("card_cancel"); } catch (e) { toast(e.message, "error"); }
      };
      p.querySelector('[data-act="card-backup"]').onclick = (ev) => {
        const seal = sealBox.checked;
        if (seal && !confirm("Seal the backup card permanently? It can never be reset or reused.")) return;
        cancelled = false; running(true); window.cardStep = stepTo;
        stepTo({ step: 1, text: "Starting the reader…", seconds: 0 });
        busy(ev.currentTarget, async () => {
          try {
            const r = await call("card_backup", "backup", seal);
            show(r);
            toast(`Backup card ${r.card_uid} is ready${r.cards ? `. ${r.cards} cards now open this wallet` : ""}. Copy the wallet file again.`, "ok");
          } catch (e) {
            if (!cancelled) throw e;
            toast("Cancelled. Nothing was written to a new card.", "ok");
          } finally { clearInterval(clock); window.cardStep = null; running(false); }
        });
      };
      p.querySelector('[data-act="card-reset"]').onclick = (ev) => {
        if (prompt("Resetting makes this wallet unopenable. Type RESET to return the card to factory keys.") !== "RESET") return;
        toast("Hold the card on the reader…");
        busy(ev.currentTarget, async () => { show(await call("card_reset")); S = await call("state"); toast("Card reset. This wallet can no longer be opened.", "ok"); });
      };
    }
    const sf = p.querySelector('[data-f="seed"]');   // absent when this card wallet's seed is locked for good
    if (sf) {
    const syncSeed = gate(sf.querySelector("button"), () => sf.pw.value.length > 0);
    sf.pw.addEventListener("input", syncSeed);
    sf.onsubmit = (ev) => { ev.preventDefault(); if (!sf.pw.value) return;
      busy(sf.querySelector("button"), async () => {
        const seed = await call("reveal_seed", sf.pw.value); sf.pw.value = ""; syncSeed();
        const box = sf.querySelector(".seed-reveal");
        box.innerHTML = `<div class="seed-grid selectable">${seed.match(/.{8}/g).map((g, i) => `<div><i>${String(i + 1).padStart(2, "0")}</i><b>${g}</b></div>`).join("")}</div><p class="note" style="margin-top:8px">Hidden again in 60 seconds.</p>`;
        setTimeout(() => (box.innerHTML = ""), 60000);
      });
    };
    }
  }
})();
