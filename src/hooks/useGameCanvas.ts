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
        backgroundColor: 0x4a8c3f,
        antialias: false,
        resolution: window.devicePixelRatio || 1,
        autoDensity: true,
      })
      .then(() => {
        if (destroyed) {
          pixiApp.destroy(true, { children: true, texture: true });
          return;
        }
        // Ensure canvas doesn't prevent flex container from shrinking
        pixiApp.canvas.style.display = "block";
        pixiApp.canvas.style.width = "100%";
        pixiApp.canvas.style.height = "100%";
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
