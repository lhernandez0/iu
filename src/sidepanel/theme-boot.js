/**
 * Apply the last panel theme before the first paint.
 *
 * The source of truth is still `storage.local`. This is a synchronous boot cache
 * of one presentation value, because the storage API is asynchronous and a
 * sidebar can paint before it answers. It keeps the default token set from
 * flashing on open. `applyTheme()` refreshes the cache whenever the real theme
 * arrives from storage or the worker.
 *
 * A missing or unreadable cache is normal on the first open and after a storage
 * clear, not an error. The panel falls back to the default theme.
 */
(() => {
  try {
    const theme = localStorage.getItem('iu-panel-theme');
    if (theme) {
      if (theme !== 'default') document.documentElement.dataset.theme = theme;
    } else {
      document.documentElement.setAttribute('data-booting', '');
    }
  } catch {
    // Local storage disabled. The panel's normal theme path still applies.
  }
})();
