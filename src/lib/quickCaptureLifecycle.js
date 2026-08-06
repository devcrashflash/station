import { flushSync } from "react-dom";

export const QUICK_CAPTURE_DEFAULT_TAB = "inbox";

export function resetQuickCaptureTab(setActiveTab) {
  flushSync(() => {
    setActiveTab(QUICK_CAPTURE_DEFAULT_TAB);
  });
}
