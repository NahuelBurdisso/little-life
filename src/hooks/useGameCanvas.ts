import { useRef, useEffect, useState } from "react";
import { Application } from "pixi.js";

export function useGameCanvas() {
  const containerRef = useRef<HTMLDivElement>(null);
  const [app, setApp] = useState<Application | null>(null);

  useEffect(() => {
    if (!containerRef.current) return;

    const container = containerRef.current;
    let destroyed = false;

    const pixiApp = new Application();

    pixiApp
      .init({
        resizeTo: container,
        backgroundColor: 0x2d5a27,
        antialias: false,
        resolution: window.devicePixelRatio || 1,
        autoDensity: true,
      })
      .then(() => {
        if (destroyed) {
          pixiApp.destroy(true, { children: true, texture: true });
          return;
        }
        container.appendChild(pixiApp.canvas);
        setApp(pixiApp);
      });

    return () => {
      destroyed = true;
      try {
        const canvas = pixiApp.canvas;
        if (canvas?.parentNode) {
          canvas.parentNode.removeChild(canvas);
        }
        pixiApp.destroy(true, { children: true, texture: true });
      } catch {
        // App not fully initialized yet — init() promise will handle cleanup via `destroyed` flag
      }
      setApp(null);
    };
  }, []);

  return { app, containerRef };
}
