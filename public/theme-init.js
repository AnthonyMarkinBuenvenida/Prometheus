// Applies the saved theme before first paint so White + Gold users don't see a dark flash.
// External file (not inline) because the Content-Security-Policy only allows 'self' scripts.
// Must stay in sync with THEMES / THEME_COLOR in src/lib/settingsModel.ts.
(function () {
  var colors = { dark: "#0b0b0d", black: "#000000", light: "#ffffff" };
  try {
    // "hivemind.v1." is the key from the app's former name, until src/lib/storage.ts copies it over.
    var saved = localStorage.getItem("prometheus.v1.settings") || localStorage.getItem("hivemind.v1.settings");
    var theme = JSON.parse(saved || "{}").theme;
    if (!colors[theme]) return;
    document.documentElement.dataset.theme = theme;
    var meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute("content", colors[theme]);
  } catch (e) {
    /* storage blocked: keep the default dark theme */
  }
})();
