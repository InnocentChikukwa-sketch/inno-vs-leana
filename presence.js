/* Game room presence: tells your partner which game you have open, and asks you to join theirs.
   Runs on the landing page and in every game, over the couple's own private channel.
   Use: <script src="presence.js" data-game="snakes" data-title="Snakes & Ladders" data-url="snakes.html"></script>
   (the landing page leaves data-game empty) */
(function () {
  "use strict";
  const me_script = document.currentScript;
  const GAME = (me_script && me_script.dataset.game) || "";
  const TITLE = (me_script && me_script.dataset.title) || "";
  const URL_ = (me_script && me_script.dataset.url) || "";
  const BROKERS=["wss://broker.hivemq.com:8884/mqtt","wss://broker.emqx.io:8084/mqtt"];
  const C = window.GR && GR.couple();
  if (!C || typeof mqtt === "undefined") return;
  const BASE = "gr-lobby/" + C.room + "/";
  const cid = Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  const FRESH = 75000; // a "here" message older than this is ignored
  const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const ss = { get: (k) => { try { return sessionStorage.getItem(k); } catch (e) { return null; } }, set: (k, v) => { try { sessionStorage.setItem(k, v); } catch (e) {} } };

  /* ---------- the pop-up ---------- */
  const css = document.createElement("style");
  css.textContent = `
  .gr-join{position:fixed;left:50%;bottom:max(14px,env(safe-area-inset-bottom,0px));transform:translate(-50%,160%);width:min(488px,calc(100% - 24px));z-index:60;
    background:#FFD200;color:#000;border-radius:20px;padding:14px 14px 14px 16px;box-shadow:0 6px 0 rgba(0,0,0,.85),0 20px 40px -12px rgba(0,0,0,.6);
    display:flex;align-items:center;gap:12px;font-family:Figtree,system-ui,sans-serif;transition:transform .32s cubic-bezier(.2,.9,.25,1.1)}
  .gr-join.show{transform:translate(-50%,0)}
  .gr-join .gr-dot{width:12px;height:12px;border-radius:50%;background:#0E6B3A;box-shadow:0 0 0 4px rgba(14,107,58,.25);flex:none;animation:grp 1.4s ease-in-out infinite}
  @keyframes grp{50%{box-shadow:0 0 0 8px rgba(14,107,58,0)}}
  .gr-join .gr-t{flex:1;min-width:0;font-size:15px;line-height:1.3}
  .gr-join .gr-t b{display:block;font-family:"Bricolage Grotesque",system-ui,sans-serif;font-weight:800;font-size:18px;letter-spacing:-.01em}
  .gr-join a{flex:none;background:#000;color:#FFD200;text-decoration:none;font-weight:800;font-size:16px;padding:12px 16px;border-radius:999px}
  .gr-join button{flex:none;background:none;border:0;font:inherit;font-size:14px;font-weight:700;color:#000;text-decoration:underline;padding:6px 2px;cursor:pointer}
  .gr-join a:focus-visible,.gr-join button:focus-visible{outline:3px solid #000;outline-offset:2px}
  @media (prefers-reduced-motion:reduce){.gr-join{transition:none}.gr-join .gr-dot{animation:none}}`;
  document.head.appendChild(css);
  const box = document.createElement("div");
  box.className = "gr-join"; box.setAttribute("role", "dialog"); box.setAttribute("aria-live", "assertive"); box.setAttribute("aria-label", "Join your partner");
  document.body.appendChild(box);
  let shownFor = null;
  function show(p) {
    shownFor = p.game;
    box.innerHTML = `<span class="gr-dot" aria-hidden="true"></span><span class="gr-t"><b>${esc(C.partner)} is in ${esc(p.title)}</b>${GAME ? "Leave this game and join them?" : "Join them now?"}</span>
      <a href="${esc(p.url)}">Join</a><button type="button" data-x>Later</button>`;
    requestAnimationFrame(() => box.classList.add("show"));
  }
  function hide() { box.classList.remove("show"); shownFor = null; }
  box.addEventListener("click", (e) => {
    if (e.target.closest("[data-x]")) { ss.set("gr.later." + C.partner + "." + shownFor, String(Date.now())); hide(); }
  });

  /* ---------- phone notification when the site isn't on screen ---------- */
  let swReg = null;
  if ("serviceWorker" in navigator && location.protocol === "https:") navigator.serviceWorker.register("sw.js").then((r) => { swReg = r; }).catch(() => {});
  function notify(p) {
    if (!("Notification" in window) || Notification.permission !== "granted") return;
    const opts = { body: `Tap to join them in ${p.title}.`, tag: "gr-join-" + p.game, renotify: true, vibrate: [150, 80, 150], data: { url: location.origin + "/" + p.url } };
    if (swReg) swReg.showNotification(`${C.partner} opened ${p.title}`, opts).catch(() => {});
    else { try { new Notification(`${C.partner} opened ${p.title}`, opts); } catch (e) {} }
  }

  /* ---------- what the partner is doing ---------- */
  let partnerAt = null;           // {game,title,url,ts}
  const notified = {};            // game -> time a notification went out
  function consider(p) {
    partnerAt = p;
    window.dispatchEvent(new CustomEvent("gr-presence", { detail: p }));
    if (!p || !p.game || p.game === GAME) { if (shownFor) hide(); return; }
    const later = Number(ss.get("gr.later." + C.partner + "." + p.game)) || 0;
    if (Date.now() - later < 10 * 60 * 1000) return;   // "Later" keeps it quiet for 10 minutes
    if (document.hidden) {
      if (Date.now() - (notified[p.game] || 0) > 10 * 60 * 1000) { notified[p.game] = Date.now(); notify(p); }
      pendingShow = p; return;
    }
    if (shownFor !== p.game) show(p);
  }
  let pendingShow = null;
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) { announce(); if (pendingShow) { const p = pendingShow; pendingShow = null; if (partnerAt && partnerAt.game === p.game) consider(p); } }
  });
  setInterval(() => { if (partnerAt && partnerAt.game && Date.now() - partnerAt.ts > FRESH) consider(null); }, 10000);
  window.GRPresence = { partnerAt: () => partnerAt };

  /* ---------- transport ---------- */
  const clients = [];
  function publish(obj, retain) {
    const s = JSON.stringify(obj);
    clients.forEach((c) => { try { if (c._up) c.publish(BASE + "here/" + C.me.toLowerCase(), s, { qos: 1, retain: !!retain }); } catch (e) {} });
  }
  function announce() { publish({ who: C.me, game: GAME, title: TITLE, url: URL_, ts: Date.now(), cid }, true); }
  BROKERS.forEach((url, i) => {
    let c; try { c = mqtt.connect(url, { clientId: "grp_" + cid + "_" + i, clean: true, reconnectPeriod: 5000, connectTimeout: 10000, keepalive: 30, protocolVersion: 4 }); } catch (e) { return; }
    c._up = false;
    c.on("connect", () => { c._up = true; c.subscribe(BASE + "here/+", { qos: 1 }, () => announce()); });
    c.on("close", () => { c._up = false; }); c.on("offline", () => { c._up = false; }); c.on("error", () => {});
    c.on("message", (topic, buf) => {
      let d; try { d = JSON.parse(buf.toString()); } catch (e) { return; }
      if (!d || d.cid === cid || String(d.who).toLowerCase() !== C.partner.toLowerCase()) return;
      if (Date.now() - Number(d.ts || 0) > FRESH) return;
      if (partnerAt && partnerAt.ts > d.ts && partnerAt.game !== d.game) return;   // older news from the other relay
      consider({ game: d.game || "", title: String(d.title || "").slice(0, 40), url: String(d.url || "").replace(/[^a-z0-9._-]/gi, ""), ts: Number(d.ts) });
    });
    clients.push(c);
  });
  setInterval(() => { if (!document.hidden) announce(); }, 25000);
  window.addEventListener("pagehide", () => publish({ who: C.me, game: "", title: "", url: "", ts: Date.now(), cid }, true));
})();
