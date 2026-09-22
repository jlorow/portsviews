/* Portsviews — shared theme toggle (LANDING-3 A2).
   One copy of what was duplicated inline on four pages.

   The icons themselves live in the markup, both of them, and CSS decides
   which is visible from data-theme (styles.css, "theme toggle"). So the
   correct icon is on screen as soon as the attribute is right, with no
   swap to watch.

   This file is loaded from <head> WITHOUT defer, on purpose: a saved light
   theme has to reach <html> before the first paint, or a light-mode
   visitor gets a dark flash on every page load. That means the button does
   not exist yet when the script first runs, so labelling it is deferred to
   DOMContentLoaded. */
(function () {
  var STORAGE_KEY = 'portsviews-theme';

  function isDark() {
    return document.documentElement.getAttribute('data-theme') !== 'light';
  }

  function labelButton() {
    var button = document.getElementById('theme-toggle');
    if (!button) return;
    var label = isDark() ? 'Switch to light mode' : 'Switch to dark mode';
    button.setAttribute('aria-label', label);
    button.setAttribute('title', label);
  }

  function setTheme(dark) {
    document.documentElement.setAttribute('data-theme', dark ? 'dark' : 'light');
    labelButton();
    // Private browsing and blocked site data throw here rather than
    // returning null, so the theme still switches when it cannot be saved.
    try { localStorage.setItem(STORAGE_KEY, dark ? 'dark' : 'light'); } catch (e) {}
  }

  function toggleTheme() {
    setTheme(!isDark());
  }

  // Kept global: the buttons call onclick="toggleTheme()", which is how the
  // pages already invoked it.
  window.toggleTheme = toggleTheme;

  var saved = null;
  try { saved = localStorage.getItem(STORAGE_KEY); } catch (e) {}
  setTheme(saved !== 'light');

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', labelButton);
  } else {
    labelButton();
  }
})();
