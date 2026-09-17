// Bound a human approval and propagate cancellation to the local dialog.
export async function confirmPairingWithDeadline(confirm, keyId) {
  if (!confirm) return true;
  const controller = new AbortController();
  let timer;
  const timeout = new Promise(resolve => {
    timer = setTimeout(() => { controller.abort(); resolve(false); }, 45000);
  });
  try { return await Promise.race([Promise.resolve().then(() => confirm({ keyId, signal: controller.signal })), timeout]); }
  finally { clearTimeout(timer); }
}
