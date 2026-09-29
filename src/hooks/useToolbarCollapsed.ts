import { useCallback, useEffect, useState } from "react";
import { readToolbarPref, resolveToolbarCollapsed, writeToolbarPref } from "../lib/toolbarLayout";

/**
 * Whether the floating tools strip is folded into its icon rail. The player's
 * last choice is remembered (localStorage); until they make one it follows the
 * window width, so a small screen starts folded and a resize re-evaluates.
 * Lives in App rather than in the strip because the map overlays (director
 * captions) size their clearance from it.
 */
export function useToolbarCollapsed() {
  const [pref, setPref] = useState<boolean | null>(() => readToolbarPref());
  const [width, setWidth] = useState(() => (typeof window === "undefined" ? 1920 : window.innerWidth));

  useEffect(() => {
    const onResize = () => setWidth(window.innerWidth);
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  const collapsed = resolveToolbarCollapsed(pref, width);
  const toggle = useCallback(() => {
    const next = !collapsed;
    setPref(next);
    writeToolbarPref(next);
  }, [collapsed]);

  return { collapsed, toggle };
}
