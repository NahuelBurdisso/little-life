import { useCallback, useState } from "react";
import { readCinematic, writeCinematic } from "../lib/cinematic";

/** The "Cinematic moments" preference (fade to black on a watched couple's night), remembered per browser. */
export function useCinematic() {
  const [enabled, setEnabled] = useState(() => readCinematic());
  const toggle = useCallback(() => {
    writeCinematic(!enabled);
    setEnabled(!enabled);
  }, [enabled]);
  return { enabled, toggle };
}
