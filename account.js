/* Game room accounts: shared by the landing page and every game.
   Keeps you signed in on this phone, remembers your partners and which one you're playing with,
   and gives each game the private room it should use. */
(function () {
  "use strict";
  const DEFAULT_API = "https://game-room-api.onrender.com";
  const get = (k) => { try { return localStorage.getItem(k); } catch (e) { return null; } };
  const set = (k, v) => { try { v == null ? localStorage.removeItem(k) : localStorage.setItem(k, v); } catch (e) {} };
  const getJ = (k) => { try { return JSON.parse(get(k) || "null"); } catch (e) { return null; } };
  const API = (get("gr.api") || DEFAULT_API).replace(/\/+$/, "");

  function session() { const s = getJ("gr.session"); return s && s.token && s.username ? s : null; }
  function me() { return getJ("gr.me"); }
  const lc = (s) => String(s || "").toLowerCase();

  // the couple this phone is playing as right now (works offline, from what was saved)
  function couple(partnerName) {
    const s = session(), m = me();
    if (!s || !m || !Array.isArray(m.partners) || !m.partners.length) return null;
    const want = partnerName || get("gr.partner");
    const p = m.partners.find((x) => lc(x.username) === lc(want)) || m.partners[0];
    const names = [s.username, p.username].sort((a, b) => (lc(a) < lc(b) ? -1 : lc(a) > lc(b) ? 1 : 0));
    // The games use two fixed seats internally; seat 1 is the alphabetically first name.
    return { me: s.username, partner: p.username, room: p.room,
      slots: { inno: names[0], leana: names[1] },
      mySlot: lc(names[0]) === lc(s.username) ? "inno" : "leana" };
  }
  function choosePartner(name) { set("gr.partner", name); }

  async function call(path, opts) {
    opts = opts || {};
    const s = session();
    const headers = { "content-type": "application/json" };
    if (s) headers.authorization = "Bearer " + s.token;
    let slowTimer = null;
    if (opts.onSlow) slowTimer = setTimeout(opts.onSlow, 3500);
    try {
      const r = await fetch(API + path, { method: opts.method || "GET", headers, body: opts.body ? JSON.stringify(opts.body) : undefined });
      const data = await r.json().catch(() => ({}));
      if (r.status === 401 && s && path !== "/api/login") { set("gr.session", null); }
      if (!r.ok) { const e = new Error(data.error || "Something went wrong. Try again."); e.field = data.field; e.status = r.status; throw e; }
      return data;
    } catch (e) {
      if (e instanceof TypeError) throw new Error("Can't reach the server. Check your internet and try again.");
      throw e;
    } finally { clearTimeout(slowTimer); }
  }
  function keep(data) {
    if (data && data.user) set("gr.me", JSON.stringify({ user: data.user, partners: data.partners || [], invites: data.invites || { incoming: [], outgoing: [] } }));
    if (data && data.token && data.user) set("gr.session", JSON.stringify({ token: data.token, username: data.user.username }));
    return data;
  }

  window.GR = {
    API, session, me, couple, choosePartner,
    available: (u, o) => call("/api/available?u=" + encodeURIComponent(u), o),
    register: (b, o) => call("/api/register", Object.assign({ method: "POST", body: b }, o)).then(keep),
    login: (b, o) => call("/api/login", Object.assign({ method: "POST", body: b }, o)).then(keep),
    refresh: (o) => call("/api/me", o).then(keep),
    invite: (u, o) => call("/api/invite", Object.assign({ method: "POST", body: { username: u } }, o)).then(keep),
    respond: (u, accept, o) => call("/api/invite/respond", Object.assign({ method: "POST", body: { username: u, accept: !!accept } }, o)).then(keep),
    cancel: (u, o) => call("/api/invite/cancel", Object.assign({ method: "POST", body: { username: u } }, o)).then(keep),
    logout: async () => { try { await call("/api/logout", { method: "POST" }); } catch (e) {} set("gr.session", null); set("gr.me", null); set("gr.partner", null); },
  };
})();
