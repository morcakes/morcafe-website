/* =========================================================
   מורקפה — תפריט נגישות (Accessibility widget)
   ת"י 5568 · שומר העדפות בין ביקורים (localStorage)
   ========================================================= */
(function () {
  "use strict";

  var KEY = "morcafe-a11y";
  var state = { fs: 0, dark: false, gray: false, links: false, font: false, noanim: false, cursor: false };

  try {
    var saved = JSON.parse(localStorage.getItem(KEY));
    if (saved) for (var k in state) if (Object.prototype.hasOwnProperty.call(saved, k)) state[k] = saved[k];
  } catch (e) { /* localStorage unavailable — run without persistence */ }

  var root = document.documentElement;

  function apply() {
    root.classList.remove("a11y-fs-1", "a11y-fs-2", "a11y-fs-3");
    if (state.fs > 0) root.classList.add("a11y-fs-" + state.fs);
    root.classList.toggle("a11y-dark", state.dark);
    root.classList.toggle("a11y-gray", state.gray);
    root.classList.toggle("a11y-links", state.links);
    root.classList.toggle("a11y-font", state.font);
    root.classList.toggle("a11y-noanim", state.noanim);
    root.classList.toggle("a11y-cursor", state.cursor);
    try { localStorage.setItem(KEY, JSON.stringify(state)); } catch (e) {}
  }
  apply();

  /* ---------- build the UI ---------- */
  var btn = document.createElement("button");
  btn.id = "a11yBtn";
  btn.type = "button";
  btn.setAttribute("aria-label", "פתיחת תפריט נגישות");
  btn.setAttribute("aria-expanded", "false");
  btn.setAttribute("aria-controls", "a11yPanel");
  btn.innerHTML = '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M12 2a2 2 0 1 1 0 4 2 2 0 0 1 0-4zm9 7h-6v13h-2v-6h-2v6H9V9H3V7h18v2z"/></svg>';

  var toggles = [
    ["dark",   "ניגודיות כהה"],
    ["gray",   "גווני אפור"],
    ["links",  "הדגשת קישורים"],
    ["font",   "פונט קריא"],
    ["noanim", "עצירת אנימציות"],
    ["cursor", "סמן גדול"]
  ];

  var panel = document.createElement("div");
  panel.id = "a11yPanel";
  panel.setAttribute("role", "dialog");
  panel.setAttribute("aria-label", "הגדרות נגישות");
  panel.hidden = true;

  var html = '';
  html += '<div class="a11y-top"><strong>הגדרות נגישות</strong>';
  html += '<button type="button" class="a11y-close" aria-label="סגירת תפריט נגישות">✕</button></div>';
  html += '<div class="a11y-fsrow"><span id="a11yFsLabel">גודל טקסט</span>';
  html += '<span class="a11y-fsbtns" role="group" aria-labelledby="a11yFsLabel">';
  html += '<button type="button" class="a11y-fsbtn" data-fs="-1" aria-label="הקטנת טקסט">א−</button>';
  html += '<span class="a11y-fslevel" aria-live="polite">רגיל</span>';
  html += '<button type="button" class="a11y-fsbtn" data-fs="1" aria-label="הגדלת טקסט">א+</button>';
  html += '</span></div>';
  for (var i = 0; i < toggles.length; i++) {
    html += '<button type="button" class="a11y-toggle" data-key="' + toggles[i][0] + '" aria-pressed="false">';
    html += '<span class="a11y-dot" aria-hidden="true"></span>' + toggles[i][1] + '</button>';
  }
  html += '<div class="a11y-foot">';
  html += '<a href="accessibility.html">הצהרת נגישות</a>';
  html += '<button type="button" class="a11y-reset">איפוס הגדרות</button>';
  html += '</div>';
  panel.innerHTML = html;

  document.body.appendChild(btn);
  document.body.appendChild(panel);

  var fsLevelNames = ["רגיל", "גדול", "גדול מאוד", "ענק"];

  function sync() {
    var togs = panel.querySelectorAll(".a11y-toggle");
    for (var i = 0; i < togs.length; i++) {
      togs[i].setAttribute("aria-pressed", state[togs[i].getAttribute("data-key")] ? "true" : "false");
    }
    panel.querySelector(".a11y-fslevel").textContent = fsLevelNames[state.fs];
  }
  sync();

  /* ---------- open / close with focus management ---------- */
  function openPanel() {
    panel.hidden = false;
    btn.setAttribute("aria-expanded", "true");
    panel.querySelector(".a11y-close").focus();
  }
  function closePanel(returnFocus) {
    panel.hidden = true;
    btn.setAttribute("aria-expanded", "false");
    if (returnFocus !== false) btn.focus();
  }

  btn.addEventListener("click", function () {
    if (panel.hidden) openPanel(); else closePanel();
  });

  document.addEventListener("keydown", function (e) {
    if (e.key === "Escape" && !panel.hidden) closePanel();
  });

  document.addEventListener("click", function (e) {
    if (!panel.hidden && !panel.contains(e.target) && e.target !== btn && !btn.contains(e.target)) {
      closePanel(false);
    }
  });

  /* ---------- controls ---------- */
  panel.addEventListener("click", function (e) {
    var t = e.target.closest ? e.target.closest("button") : null;
    if (!t) return;

    if (t.classList.contains("a11y-close")) { closePanel(); return; }

    if (t.classList.contains("a11y-reset")) {
      state = { fs: 0, dark: false, gray: false, links: false, font: false, noanim: false, cursor: false };
      apply(); sync();
      return;
    }

    var fsStep = t.getAttribute("data-fs");
    if (fsStep) {
      state.fs = Math.max(0, Math.min(3, state.fs + parseInt(fsStep, 10)));
      apply(); sync();
      return;
    }

    var key = t.getAttribute("data-key");
    if (key) {
      state[key] = !state[key];
      apply(); sync();
    }
  });
})();
