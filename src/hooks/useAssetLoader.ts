import { useState, useEffect } from "react";
import * as PIXI from "pixi.js";
import { SPRITE_CONFIG, getCharacterSheet } from "../lib/spriteConfig";

const TILESET_BUNDLE: Record<string, string> = {
  "serene-village": "/sprites/limezu/serene-village.png",
  "water-waves": "/sprites/limezu/water-waves.png",
  "campfire": "/sprites/limezu/campfire.png",
  "door": "/sprites/limezu/door.png",
};

function buildCharacterBundle(): Record<string, string> {
  const bundle: Record<string, string> = {};
  const animations = ["walk", "run", "idle", "idle-anim", "phone", "sit"];
  for (const base of SPRITE_CONFIG.CHARACTER_BASES) {
    for (const anim of animations) {
      const key = anim === "walk" ? base : `${base}-${anim}`;
      bundle[key] = getCharacterSheet(base, anim === "walk" ? undefined : anim);
    }
  }
  return bundle;
}

let registered = false;

export function useAssetLoader(app: PIXI.Application | null) {
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    if (!app || loaded) return;

    if (!registered) {
      PIXI.Assets.addBundle("tileset", TILESET_BUNDLE);
      PIXI.Assets.addBundle("characters", buildCharacterBundle());
      registered = true;
    }

    PIXI.Assets.loadBundle(["tileset", "characters"]).then(() => {
      setLoaded(true);
    });
  }, [app, loaded]);

  return loaded;
}
