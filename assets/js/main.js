/* =========================================================
   מורקפה · MorCafe — interactions
   ========================================================= */
(function () {
  "use strict";

  /* ---------- current year ---------- */
  var yEl = document.getElementById("year");
  if (yEl) yEl.textContent = new Date().getFullYear();

  /* ---------- navbar background on scroll ---------- */
  var nav = document.getElementById("nav");
  if (nav && !nav.classList.contains("scrolled")) {
    var onScroll = function () {
      if (window.scrollY > 40) nav.classList.add("scrolled");
      else nav.classList.remove("scrolled");
    };
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
  }

  /* ---------- mobile drawer ---------- */
  var burger = document.getElementById("burger");
  var drawer = document.getElementById("mobileMenu");
  if (burger && drawer) {
    var toggle = function (force) {
      var open = force !== undefined ? force : !drawer.classList.contains("open");
      drawer.classList.toggle("open", open);
      burger.classList.toggle("open", open);
      burger.setAttribute("aria-expanded", open ? "true" : "false");
      document.body.style.overflow = open ? "hidden" : "";
      // keyboard focus follows the drawer state
      if (open) {
        var first = drawer.querySelector("a");
        if (first) setTimeout(function () { first.focus(); }, 80);
      } else if (document.activeElement && drawer.contains(document.activeElement)) {
        burger.focus();
      }
    };
    burger.addEventListener("click", function () { toggle(); });
    drawer.querySelectorAll("a").forEach(function (a) {
      a.addEventListener("click", function () { toggle(false); });
    });
    document.addEventListener("keydown", function (e) {
      if (e.key === "Escape") toggle(false);
    });
  }

  /* ---------- ribbon ticker: clone the set once for a seamless infinite loop ---------- */
  var ribbonTrack = document.getElementById("ribbonTrack");
  if (ribbonTrack) {
    var ribbonItems = Array.prototype.slice.call(ribbonTrack.children);
    ribbonItems.forEach(function (item) {
      var clone = item.cloneNode(true);
      clone.setAttribute("aria-hidden", "true");
      ribbonTrack.appendChild(clone);
    });
  }

  /* ---------- reviews marquee: clone cards for a seamless infinite loop ---------- */
  var reviewsTrack = document.getElementById("reviewsTrack");
  if (reviewsTrack) {
    var originals = Array.prototype.slice.call(reviewsTrack.children);
    originals.forEach(function (card) {
      var clone = card.cloneNode(true);
      clone.setAttribute("aria-hidden", "true");
      var star = clone.querySelector("small");
      if (star) star.removeAttribute("aria-label"); // avoid duplicate SR announcements
      reviewsTrack.appendChild(clone);
    });
  }

  /* ---------- reviews nav arrows: only visible/used when the marquee has
     stopped animating (prefers-reduced-motion), as a nicer alternative to
     the bare browser scrollbar ---------- */
  var reviewsMarquee = document.querySelector(".reviews-marquee");
  var prevBtn = document.querySelector(".reviews-nav-prev");
  var nextBtn = document.querySelector(".reviews-nav-next");
  if (reviewsMarquee && prevBtn && nextBtn) {
    var cardStep = function () {
      var card = reviewsMarquee.querySelector(".review-card");
      return card ? card.getBoundingClientRect().width + 16 : 316;
    };
    prevBtn.addEventListener("click", function () { reviewsMarquee.scrollBy({ left: cardStep(), behavior: "smooth" }); });
    nextBtn.addEventListener("click", function () { reviewsMarquee.scrollBy({ left: -cardStep(), behavior: "smooth" }); });
  }

  /* ---------- reveal on scroll ---------- */
  var reveals = document.querySelectorAll(".reveal");
  if ("IntersectionObserver" in window && reveals.length) {
    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (en) {
        if (en.isIntersecting) {
          en.target.classList.add("in");
          io.unobserve(en.target);
        }
      });
    }, { threshold: 0.14, rootMargin: "0px 0px -8% 0px" });
    reveals.forEach(function (el) { io.observe(el); });
  } else {
    reveals.forEach(function (el) { el.classList.add("in"); });
  }

  /* ---------- opening hours: highlight today + open/closed ---------- */
  // schedule: [openMinutes, closeMinutes] or null when closed. index = getDay() (0=Sun)
  var schedule = [null, null, null, null, [510, 810], [510, 810], null]; // Thu & Fri 08:30–13:30
  var now = new Date();
  var todayIdx = now.getDay();
  var minutes = now.getHours() * 60 + now.getMinutes();

  var todayRow = document.querySelector('.hours-list li[data-day="' + todayIdx + '"]');
  if (todayRow) todayRow.classList.add("today");

  var isOpen = false;
  var slot = schedule[todayIdx];
  if (slot && minutes >= slot[0] && minutes < slot[1]) isOpen = true;

  var badge = document.getElementById("openNow");
  var badgeText = document.getElementById("openNowText");
  if (badge && badgeText) {
    if (isOpen) {
      badge.classList.add("is-open");
      badgeText.textContent = "פתוח עכשיו · עד 13:30";
    } else {
      badge.classList.add("is-closed");
      // find next opening day
      var nextTxt = "סגור כעת";
      var names = ["ראשון", "שני", "שלישי", "רביעי", "חמישי", "שישי", "שבת"];
      for (var i = 1; i <= 7; i++) {
        var d = (todayIdx + i) % 7;
        if (schedule[d]) {
          if (i === 1) nextTxt = "סגור · נפתח מחר ב־8:30";
          else nextTxt = "סגור · נפתח ביום " + names[d] + " ב־8:30";
          break;
        }
      }
      // if today is an open day but before opening time
      if (slot && minutes < slot[0]) nextTxt = "סגור · נפתח היום ב־8:30";
      badgeText.textContent = nextTxt;
    }
  }

  /* ---------- menu page: sticky category nav active state ---------- */
  var menuNav = document.getElementById("menuNav");
  if (menuNav) {
    var links = Array.prototype.slice.call(menuNav.querySelectorAll("a"));
    var sections = links
      .map(function (l) { return document.querySelector(l.getAttribute("href")); })
      .filter(Boolean);

    // smooth offset scrolling accounting for sticky headers
    links.forEach(function (l) {
      l.addEventListener("click", function (e) {
        var target = document.querySelector(l.getAttribute("href"));
        if (!target) return;
        e.preventDefault();
        var top = target.getBoundingClientRect().top + window.scrollY - 118;
        window.scrollTo({ top: top, behavior: "smooth" });
      });
    });

    if ("IntersectionObserver" in window && sections.length) {
      var mio = new IntersectionObserver(function (entries) {
        entries.forEach(function (en) {
          if (en.isIntersecting) {
            var id = en.target.getAttribute("id");
            links.forEach(function (l) {
              l.classList.toggle("active", l.getAttribute("href") === "#" + id);
            });
          }
        });
      }, { rootMargin: "-30% 0px -60% 0px", threshold: 0 });
      sections.forEach(function (s) { mio.observe(s); });
    }
  }

  /* ---------- smooth in-page anchors (home) with nav offset ---------- */
  document.querySelectorAll('a[href^="#"]').forEach(function (a) {
    var href = a.getAttribute("href");
    if (href === "#" || a.closest("#menuNav")) return;
    a.addEventListener("click", function (e) {
      var target = document.querySelector(href);
      if (!target) return;
      e.preventDefault();
      var top = target.getBoundingClientRect().top + window.scrollY - 70;
      window.scrollTo({ top: top, behavior: "smooth" });
    });
  });
})();
