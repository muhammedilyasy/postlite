// Applies the saved theme before first paint (classic script, CSP-safe). 'dark' is the default.
(function () {
  try {
    var t = localStorage.getItem('pl_theme') || 'dark';
    if (t === 'system') t = matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
    document.documentElement.setAttribute('data-theme', t);
  } catch (e) { document.documentElement.setAttribute('data-theme', 'dark'); }
})();
