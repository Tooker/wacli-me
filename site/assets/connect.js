// Linking page: start a session, draw each QR code the server streams, count
// the code's life down, and show the endpoint once WhatsApp confirms.
(function () {
  var qrBox = document.getElementById("qr");
  var idle = document.getElementById("qr-idle");
  var startBtn = document.getElementById("start");
  var allowSend = document.getElementById("allow-send");
  var acceptDpa = document.getElementById("accept-dpa");
  var countdown = document.getElementById("countdown");
  var secsEl = document.getElementById("secs");
  var stateEl = document.getElementById("state");
  var result = document.getElementById("result");
  var tokenOut = document.getElementById("token-out");
  var cmdClaude = document.getElementById("cmd-claude");

  var expiresAt = 0;
  var ticker = null;
  var sessionId = null;

  // OAuth mode: a client sent the visitor here through /oauth/authorize. Once
  // WhatsApp confirms, we hand the code back to the client instead of showing
  // a token the visitor would have to copy.
  var params = new URLSearchParams(location.search);
  var authId = params.get("auth");
  var clientName = params.get("client") || "your MCP client";

  function say(text, isError) {
    stateEl.textContent = text || "";
    stateEl.className = "state" + (isError ? " err" : "");
  }

  function drawQr(payload) {
    var qr = qrcode(0, "L");
    qr.addData(payload);
    qr.make();
    var n = qr.getModuleCount();
    var parts = [
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ' + n + " " + n + '" shape-rendering="crispEdges">',
      '<rect width="' + n + '" height="' + n + '" fill="#fff"/>',
    ];
    for (var r = 0; r < n; r++) {
      for (var c = 0; c < n; c++) {
        if (qr.isDark(r, c)) {
          parts.push('<rect x="' + c + '" y="' + r + '" width="1" height="1" fill="#04150e"/>');
        }
      }
    }
    parts.push("</svg>");
    qrBox.innerHTML = parts.join("");
  }

  function tick() {
    var left = Math.max(0, Math.round((expiresAt - Date.now()) / 1000));
    secsEl.textContent = left;
    countdown.classList.toggle("stale", left <= 10);
    if (left === 0) say("Code expired — waiting for a fresh one…");
  }

  function onUpdate(data) {
    if (data.status === "waiting") {
      if (data.qr) {
        drawQr(data.qr);
        expiresAt = data.expiresAt;
        countdown.hidden = false;
        say("Waiting for you to scan…");
        if (!ticker) ticker = setInterval(tick, 500);
        tick();
      } else {
        say("Asking WhatsApp for a code…");
      }
      return;
    }

    clearInterval(ticker);
    ticker = null;
    countdown.hidden = true;

    if (data.status === "linked") {
      qrBox.innerHTML = '<span class="qr-idle" style="color:#04150e;font-weight:600">Linked ✓</span>';

      if (authId) {
        say("Linked. Handing you back to " + clientName + "…");
        fetch("/api/connect/finish", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ session: sessionId, auth: authId }),
        })
          .then(function (r) {
            return r.json().then(function (body) {
              if (!r.ok) throw new Error(body.error || "could not finish");
              return body;
            });
          })
          .then(function (body) {
            location.assign(body.redirect);
          })
          .catch(function (err) {
            say(err.message + " Your token is below — add it to the client by hand.", true);
            showToken(data.token);
          });
        return;
      }

      say("Your account is linked. Your endpoint is below.");
      showToken(data.token);
      return;
    }

    qrBox.innerHTML = '<span class="qr-idle">' + (data.error || "Linking stopped.") + "</span>";
    say(data.error || "Linking stopped.", true);
    startBtn.hidden = false;
    startBtn.textContent = "Try again";
  }

  function showToken(token) {
    startBtn.hidden = true;
    allowSend.parentElement.hidden = true;
    if (acceptDpa) acceptDpa.parentElement.hidden = true;
    tokenOut.textContent = token;
    cmdClaude.innerHTML = cmdClaude.innerHTML.replace("&lt;token&gt;", token);
    result.classList.add("on");
    result.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  if (authId) {
    var banner = document.getElementById("oauth-banner");
    if (banner) {
      banner.hidden = false;
      document.getElementById("oauth-client").textContent = clientName;
    }
  }

  function start() {
    startBtn.hidden = true;
    if (idle) idle.textContent = "Asking WhatsApp for a code…";
    say("Starting…");

    fetch("/api/connect/start", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ allowSend: allowSend.checked, dpa: !!(acceptDpa && acceptDpa.checked) }),
    })
      .then(function (r) {
        return r.json().then(function (body) {
          if (!r.ok) throw new Error(body.error || "could not start");
          return body;
        });
      })
      .then(function (body) {
        sessionId = body.session;
        var es = new EventSource("/api/connect/stream?s=" + encodeURIComponent(body.session));
        es.onmessage = function (event) {
          var data = JSON.parse(event.data);
          onUpdate(data);
          if (data.status !== "waiting") es.close();
        };
        es.onerror = function () {
          es.close();
          say("Connection to the server dropped. Reload and try again.", true);
          startBtn.hidden = false;
        };
      })
      .catch(function (err) {
        say(err.message, true);
        startBtn.hidden = false;
        startBtn.textContent = "Try again";
      });
  }

  startBtn.addEventListener("click", start);

  // The QR is already on screen by the time anyone reads the checkbox, so the
  // choice travels separately. The server only reads it when WhatsApp confirms.
  function sendPermission(patch) {
    if (!sessionId) return;
    patch.session = sessionId;
    fetch("/api/connect/permissions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(patch),
    }).catch(function () {
      /* the value is re-sent on the next toggle; nothing to undo here */
    });
  }

  allowSend.addEventListener("change", function () {
    sendPermission({ allowSend: allowSend.checked });
  });

  if (acceptDpa) {
    acceptDpa.addEventListener("change", function () {
      sendPermission({ dpa: acceptDpa.checked });
    });
  }

  // An abandoned tab holds one of very few linking slots. Hand it back.
  window.addEventListener("pagehide", function () {
    if (!sessionId || result.classList.contains("on")) return;
    if (navigator.sendBeacon) navigator.sendBeacon("/api/connect/cancel", sessionId);
  });

  start();

  document.addEventListener("click", function (event) {
    var copyBtn = event.target.closest("[data-copy]");
    if (copyBtn) {
      var text = document.getElementById(copyBtn.dataset.copy).textContent;
      navigator.clipboard.writeText(text).then(function () {
        var original = copyBtn.textContent;
        copyBtn.textContent = "Copied";
        setTimeout(function () {
          copyBtn.textContent = original;
        }, 1500);
      });
      return;
    }

    var tab = event.target.closest(".tab-btn");
    if (!tab) return;
    document.querySelectorAll(".tab-btn").forEach(function (b) {
      b.setAttribute("aria-selected", String(b === tab));
      document.getElementById(b.dataset.panel).hidden = b !== tab;
    });
  });
})();
