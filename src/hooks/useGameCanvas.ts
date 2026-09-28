import { useRef, useEffect, useState } from "react";
import { Application } from "pixi.js";

export function useGameCanvas() {
  const containerRef = useRef<HTMLDivElement>(null);
  const [app, setApp] = useState<Application | null>(null);

  useEffect(() => {
    if (!containerRef.current) return;

    const container = containerRef.current;
    let destroyed = false;
    let resizeObserver: ResizeObserver | null = null;

    const pixiApp = new Application();

    // Idempotent: both the cleanup and a late-resolving `init()` can reach it.
    let appDestroyed = false;
    const destroyApp = () => {
      // `renderer` is only assigned by `init()`, while `stage` exists from the
      // constructor — so `Application.destroy` tears down the stage and then
      // throws on `this.renderer.destroy(...)` when called before init resolves.
      // Latching `appDestroyed` on that failed attempt used to strand the app:
      // the `init().then()` retry below saw the flag and bailed, leaking the
      // canvas and its WebGL context for the life of the page. Under StrictMode
      // that is one leaked context per mount, and browsers force-lose the oldest
      // once ~16 are live, blanking the canvas that is actually on screen.
      // Bail without latching instead, and let `init().then()` do the real work.
      if (appDestroyed || !pixiApp.renderer) return;
      appDestroyed = true;
      // No `texture: true` — sprite textures are owned by the `Assets` cache
      // and shared with the next mount. Destroying them here leaves the cache
      // handing out dead textures, so every agent falls back to a plain
      // circle on remount.
      pixiApp.destroy(true, { children: true });
    };

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
          destroyApp();
          return;
        }
        // Ensure canvas doesn't prevent flex container from shrinking
        pixiApp.canvas.style.display = "block";
        pixiApp.canvas.style.width = "100%";
        pixiApp.canvas.style.height = "100%";
        container.appendChild(pixiApp.canvas);
        // PIXI's resizeTo only listens to window resize, so opening the agent
        // panel or dragging a ResizeHandle would stretch the canvas without
        // updating the renderer. Watch the container itself.
        // A collapsed container would resize the renderer to 0x0 and break the
        // WebGL render target, so ignore those entries.
        resizeObserver = new ResizeObserver(([entry]) => {
          if (entry.contentRect.width > 0 && entry.contentRect.height > 0) pixiApp.resize();
        });
        resizeObserver.observe(container);
        setApp(pixiApp);
      })
      // Without this an `init()` rejection — the exact failure mode of a lost or
      // exhausted WebGL context — was an unhandled promise rejection. That is
      // the whole of what this handler buys on the `init()` path: when `init()`
      // itself rejects, `renderer` was never assigned, so `destroyApp` returns
      // at its guard and the Application really is left un-destroyed. Harmless
      // — with no renderer there is no WebGL context and no GPU resource to
      // reclaim, and the object is plain garbage.
      //
      // The `destroyApp()` call matters for the OTHER failure this catches: a
      // throw from the success handler above (e.g. `appendChild` on a detached
      // container), where `init()` did resolve and there IS a live renderer to
      // tear down. Attached after `.then` for exactly that reason. `destroyApp`
      // is idempotent, so this is safe in either order relative to the
      // cleanup's `queueMicrotask(destroyApp)`.
      .catch((err) => {
        // Not necessarily `init()` — the success handler runs before this.
        console.error("PixiJS canvas setup failed (init or post-init mount):", err);
        destroyApp();
      });

    return () => {
      destroyed = true;
      resizeObserver?.disconnect();
      try {
        const canvas = pixiApp.canvas;
        if (canvas?.parentNode) {
          canvas.parentNode.removeChild(canvas);
        }
      } catch {
        // App not fully initialized yet — nothing on the page to remove.
      }
      // The Application must die LAST. This hook is called before the consumer
      // declares its own effects, so React runs this cleanup first — destroying
      // the renderer and ticker here would pull them out from under the
      // subsystems whose `destroy()` calls are still queued behind us. React
      // flushes every cleanup in the commit synchronously, so a microtask is
      // guaranteed to run after all of them.
      queueMicrotask(destroyApp);
      setApp(null);
    };
  }, []);

  return { app, containerRef };
}
