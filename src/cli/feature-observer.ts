export async function superviseFeatureObserver(
  runFeature: () => Promise<unknown>,
  observer: Promise<void>,
  onObserverFailure: () => void,
  closeObserver: () => void,
): Promise<void> {
  let featureSettled = false;
  let observerFailed = false;
  let observerError: unknown;
  const observed = observer.catch((error: unknown) => {
    observerFailed = true;
    observerError = error;
    if (!featureSettled) onObserverFailure();
  });
  try {
    await runFeature();
  } finally {
    featureSettled = true;
    closeObserver();
  }
  await observed;
  if (observerFailed) throw observerError;
}
