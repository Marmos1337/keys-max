// Sync, render-blocking: sets the stored theme before the first frame of the legal pages (theme.js is a deferred module).
(function () {
  try {
    var pref = localStorage.getItem('keys.theme') || 'auto';
    var dark = pref === 'dark' || (pref === 'auto' && window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches);
    var root = document.documentElement;
    root.dataset.theme = dark ? 'dark' : 'light';
    root.style.colorScheme = dark ? 'dark' : 'light';
    var bar = dark ? '#151c21' : '#f5f7f9', tc = document.querySelectorAll('meta[name="theme-color"]');
    for (var i = 0; i < tc.length; i++) tc[i].setAttribute('content', bar);
  } catch (e) {}
})();
