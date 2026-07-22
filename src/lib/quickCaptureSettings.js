export function quickCaptureStatus(settings) {
  if (settings?.enabled !== true) {
    return { label: "Disabled", variant: "secondary" };
  }
  if (settings?.registered === true) {
    return { label: "Active", variant: "secondary" };
  }
  return { label: "Unavailable", variant: "destructive" };
}
