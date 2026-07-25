export function selectReleaseFailures({
  bundleOnly,
  listingFailures,
  runtimeFailures,
  productionFailures,
}) {
  return [
    ...(bundleOnly ? [] : listingFailures),
    ...runtimeFailures,
    ...productionFailures,
  ];
}
