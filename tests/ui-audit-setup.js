(() => {
  // ui-audit setup script — evaluated once after first render by
  // ui-audit-driver-v2 (--setup-script). The audit runs against a fresh
  // hermetic userDataDir, so the FirstRunTip onboarding overlay
  // (packages/app/src/shell/beacon/first-run-tip.tsx) is always visible
  // and would otherwise sit in every screenshot. Mark it seen and
  // dismiss the already-mounted instance via its Skip button.
  localStorage.setItem('beacon.tip.shown', '1');
  const dialog = document.querySelector('[role="dialog"][aria-modal="true"]');
  if (!dialog) return 'no-first-run-tip';
  const skip = Array.from(dialog.querySelectorAll('button')).find(
    (b) => (b.textContent || '').trim() === 'Skip',
  );
  if (!skip) throw new Error('first-run tip present but Skip button not found');
  skip.click();
  return 'dismissed-first-run-tip';
})()
