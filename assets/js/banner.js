/* =========================================================
   מורקפה · MorCafe — הודעה קופצת (site-wide announcement modal)
   Fetches /api/banner and, when the owner has it switched on,
   opens an accessible modal. Fails silently if the API is
   unavailable so the site never breaks.
   ========================================================= */
(function () {
  "use strict";

  var SEEN_KEY = "morcafe-banner-seen";
  var lastFocus = null;
  var modal = null;
  var onKeydown = null;

  /* ------------------------------ helpers ------------------------------ */

  function seen(id) {
    try { return window.sessionStorage.getItem(SEEN_KEY) === id; } catch (e) { return false; }
  }
  function markSeen(id) {
    try { window.sessionStorage.setItem(SEEN_KEY, id); } catch (e) { /* private mode */ }
  }
  function safeHref(href) {
    return typeof href === "string" && /^(https?:\/\/|tel:|mailto:)/i.test(href) ? href : "";
  }
  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text) n.textContent = text;
    return n;
  }

  /* ------------------------------- close ------------------------------- */

  function close(id) {
    if (!modal) return;
    markSeen(id);
    modal.classList.remove("is-open");
    document.body.classList.remove("mc-modal-lock");
    if (onKeydown) document.removeEventListener("keydown", onKeydown, true);
    var node = modal;
    modal = null;
    window.setTimeout(function () {
      if (node && node.parentNode) node.parentNode.removeChild(node);
    }, 260);
    if (lastFocus && typeof lastFocus.focus === "function") {
      try { lastFocus.focus(); } catch (e) { /* element gone */ }
    }
  }

  /* -------------------------------- open ------------------------------- */

  function open(data) {
    var id = String(data.id || "0");

    var root = el("div", "mc-modal");
    root.id = "mcBanner";

    var backdrop = el("div", "mc-modal-backdrop");
    root.appendChild(backdrop);

    var card = el("div", "mc-modal-card");
    card.setAttribute("role", "dialog");
    card.setAttribute("aria-modal", "true");
    card.setAttribute("aria-labelledby", "mcBannerTitle");
    card.setAttribute("tabindex", "-1");

    /* the masking tape is drawn by .mc-modal-card::before — no element needed */

    var closeBtn = el("button", "mc-modal-close");
    closeBtn.type = "button";
    closeBtn.setAttribute("aria-label", "סגירת ההודעה");
    closeBtn.innerHTML =
      '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" focusable="false">' +
      '<path d="M6 6l12 12M18 6L6 18" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round"/></svg>';
    card.appendChild(closeBtn);

    var inner = el("div", "mc-modal-inner");

    if (data.eyebrow) inner.appendChild(el("p", "mc-modal-eyebrow", data.eyebrow));

    var h = el("h2", "mc-modal-title", data.title || "");
    h.id = "mcBannerTitle";
    if (data.title) inner.appendChild(h);

    if (data.body) inner.appendChild(el("p", "mc-modal-body", data.body));
    if (data.note) inner.appendChild(el("p", "mc-modal-note", data.note));

    var actions = el("div", "mc-modal-actions");
    var href = safeHref(data.ctaHref);
    if (href && data.ctaText) {
      var cta = el("a", "btn btn-gold mc-modal-cta", data.ctaText);
      cta.href = href;
      if (/^https?:/i.test(href)) {
        cta.target = "_blank";
        cta.rel = "noopener";
      }
      actions.appendChild(cta);
    }
    var ok = el("button", "btn btn-primary mc-modal-ok", "הבנתי, תודה");
    ok.type = "button";
    actions.appendChild(ok);
    inner.appendChild(actions);

    card.appendChild(inner);
    root.appendChild(card);
    document.body.appendChild(root);

    modal = root;
    lastFocus = document.activeElement;
    document.body.classList.add("mc-modal-lock");

    /* close handlers */
    closeBtn.addEventListener("click", function () { close(id); });
    ok.addEventListener("click", function () { close(id); });
    backdrop.addEventListener("click", function () { close(id); });

    /* Escape + focus trap */
    onKeydown = function (e) {
      if (!modal) return;
      if (e.key === "Escape") {
        e.stopPropagation();
        close(id);
        return;
      }
      if (e.key !== "Tab") return;
      var focusables = modal.querySelectorAll("a[href], button:not([disabled])");
      if (!focusables.length) return;
      var first = focusables[0];
      var last = focusables[focusables.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", onKeydown, true);

    /* let the browser paint the closed state, then animate in.
       setTimeout (not requestAnimationFrame) so the modal still opens when the
       tab is in the background and frames are not being composited. */
    window.setTimeout(function () { root.classList.add("is-open"); }, 30);
    window.setTimeout(function () { closeBtn.focus(); }, 120);
  }

  /* -------------------------------- boot ------------------------------- */

  function boot() {
    if (!window.fetch) return;
    window.fetch("/api/banner", { headers: { Accept: "application/json" } })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (payload) {
        var b = payload && payload.banner;
        if (!b || b.active !== true) return;
        if (!b.title && !b.body) return;
        if (seen(String(b.id || "0"))) return;
        window.setTimeout(function () { open(b); }, 350);
      })
      .catch(function () { /* offline / not deployed yet — stay quiet */ });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot);
  } else {
    boot();
  }
})();
