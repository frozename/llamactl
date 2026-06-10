(() => {
  // ui-audit nav script — evaluated per module by ui-audit-driver-v2
  // (--nav-script). Mirrors tests/ui-flows/tier-a-modules.ts: navigate via
  // the test-only window.useTabStore handle instead of clicking rail/tree
  // affordances, so the audit measures "module renders when its tab is
  // active", not navigation-chrome quirks.
  //
  // Placeholders substituted by the driver:
  //   {{id}}        raw module id            (e.g. models.bench)
  //   {{labelJson}} JSON-stringified label   (e.g. "Bench")
  const store = window.useTabStore;
  if (!store || typeof store.getState !== 'function') {
    throw new Error('window.useTabStore not exposed in this build');
  }
  store.getState().open({
    tabKey: 'module:{{id}}',
    title: {{labelJson}},
    kind: 'module',
    openedAt: Date.now(),
  });
})()
