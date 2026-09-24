import { useEffect, useRef, useState } from "react";

import { AppUpdateManager, createTauriUpdateAdapter } from "@/lib/appUpdater";
import { isDesktopApp } from "@/lib/ocr";

export function useAppUpdater() {
  const managerRef = useRef(null);
  if (!managerRef.current) {
    managerRef.current = new AppUpdateManager({
      desktop: isDesktopApp(),
      adapter: createTauriUpdateAdapter(),
    });
  }

  const manager = managerRef.current;
  const [state, setState] = useState(manager.snapshot);

  useEffect(() => {
    const unsubscribe = manager.subscribe(setState);
    manager.start().catch(() => {});
    return () => {
      unsubscribe();
      manager.stop().catch(() => {});
    };
  }, [manager]);

  return {
    ...state,
    check: (options) => manager.check(options),
    dismiss: () => manager.dismiss(),
    install: () => manager.install(),
  };
}
