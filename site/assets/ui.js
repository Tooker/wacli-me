// Shared page behaviour: the mobile navigation and the copy buttons that sit on
// every code block. Loaded on every page; connect.js keeps its own logic.
(function () {
  // ---------------------------------------------------------------- nav ---
  var toggle = document.getElementById("nav-toggle");
  var nav = document.getElementById("site-nav");

  if (toggle && nav) {
    var setOpen = function (open) {
      nav.classList.toggle("open", open);
      toggle.classList.toggle("on", open);
      toggle.setAttribute("aria-expanded", String(open));
    };
    toggle.addEventListener("click", function () {
      setOpen(!nav.classList.contains("open"));
    });
    nav.addEventListener("click", function (event) {
      if (event.target.closest("a")) setOpen(false);
    });
    document.addEventListener("keydown", function (event) {
      if (event.key === "Escape") setOpen(false);
    });
  }

  // -------------------------------------------------------------- copy ---
  // Every endpoint and code block gets a button. The label swap is the whole
  // animation: two stacked spans, one fades out as the other fades in, so the
  // button never changes size and never reflows the block it sits on.
  var COPY =
    '<span class="copy-face copy-idle">' +
    '<svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true"><path fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round" d="M5.5 5.5V2.75h7.75v7.75H10.5M2.75 5.5h7.75v7.75H2.75z"/></svg>' +
    "Copy</span>" +
    '<span class="copy-face copy-done">' +
    '<svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true"><path fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" d="M3 8.5 6.5 12 13 4.5"/></svg>' +
    "Copied</span>";

  function textOf(block) {
    var url = block.querySelector(".url");
    return (url || block).textContent.replace(/\s+$/, "");
  }

  function attach(block) {
    if (block.querySelector(".copy-btn")) return;
    var btn = document.createElement("button");
    btn.type = "button";
    btn.className = "copy-btn";
    btn.innerHTML = COPY;
    btn.setAttribute("aria-label", "Copy to clipboard");
    btn.addEventListener("click", function () {
      var text = textOf(block);
      var done = function () {
        btn.classList.add("done");
        clearTimeout(btn._t);
        btn._t = setTimeout(function () {
          btn.classList.remove("done");
        }, 1800);
      };
      // http:// origins, older browsers and an unfocused document all make the
      // clipboard API refuse, so the old selection trick stays as the fallback.
      var fallback = function () {
        var area = document.createElement("textarea");
        area.value = text;
        area.style.position = "fixed";
        area.style.opacity = "0";
        document.body.appendChild(area);
        area.select();
        try {
          if (document.execCommand("copy")) done();
        } catch (err) {
          /* nothing sensible left to try */
        }
        document.body.removeChild(area);
      };

      if (navigator.clipboard && navigator.clipboard.writeText) {
        // Chrome leaves this promise pending forever when the document is not
        // focused, which would leave the button silent. Give it a moment, then
        // take the old path rather than pretend nothing happened.
        var settled = false;
        var once = function (fn) {
          return function () {
            if (settled) return;
            settled = true;
            fn();
          };
        };
        navigator.clipboard.writeText(text).then(once(done), once(fallback));
        setTimeout(once(fallback), 1200);
        return;
      }
      fallback();
    });
    block.classList.add("has-copy");
    block.appendChild(btn);
  }

  // The token boxes on /connect already carry their own copy buttons.
  document.querySelectorAll("pre, .endpoint").forEach(function (block) {
    if (block.closest(".token-box")) return;
    attach(block);
  });
})();
