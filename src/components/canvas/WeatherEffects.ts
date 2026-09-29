import { Application, Container, Graphics } from "pixi.js";

interface Particle {
  graphic: Graphics;
  vx: number;
  vy: number;
  life: number;
  /**
   * Sideways wobble instead of a straight `vx` drift: x = baseX + amp * sin(age * freq).
   * Heat shimmer needs it (a shimmer that only rises is just a rising rectangle).
   */
  wobble?: { baseX: number; amp: number; freq: number };
  age: number;
}

export class WeatherEffects {
  container: Container;
  private particles: Particle[] = [];
  /**
   * Retired particle graphics, ready to be re-flown.
   *
   * `update` spawns on almost every frame (deltaTime is ~1 at 60fps and the gate
   * is `spawnTimer > 1`), so rain alone was allocating 8-16 Graphics per frame
   * and destroying as many — roughly 500-1000 geometry builds a second purely to
   * redraw the same handful of shapes. Recycling keeps the visuals identical:
   * the counts, velocities and lifetimes are unchanged, and each graphic keeps
   * the randomised size it was first drawn with, so the population stays as
   * varied as it was on the way up to steady state.
   *
   * The pool only ever holds one weather's shapes because `clearParticles`
   * empties it whenever the weather changes.
   */
  private pool: Graphics[] = [];
  private currentWeather = "";
  private spawnTimer = 0;

  constructor(app: Application) {
    this.container = new Container();
    app.stage.addChild(this.container);
  }

  update(weather: string, width: number, height: number, delta: number) {
    // If weather changed, clear old particles
    if (weather !== this.currentWeather) {
      this.clearParticles();
      this.currentWeather = weather;
    }

    // Spawn new particles
    this.spawnTimer += delta;
    if (this.spawnTimer > 1) {
      this.spawnTimer = 0;
      this.spawnParticles(weather, width, height);
    }

    // Update existing particles
    for (let i = this.particles.length - 1; i >= 0; i--) {
      const p = this.particles[i];
      p.age += delta;
      if (p.wobble) p.graphic.x = p.wobble.baseX + p.wobble.amp * Math.sin(p.age * p.wobble.freq);
      else p.graphic.x += p.vx * delta;
      p.graphic.y += p.vy * delta;
      p.life -= delta;

      if (p.life <= 0 || p.graphic.y > height + 20 || p.graphic.x > width + 20) {
        p.graphic.visible = false;
        this.pool.push(p.graphic);
        this.particles.splice(i, 1);
      }
    }
  }

  /**
   * A recycled graphic if one is free, otherwise a freshly drawn one. `draw` is
   * only invoked for new graphics — recycled ones keep their existing geometry.
   */
  private acquire(draw: (g: Graphics) => void): Graphics {
    const recycled = this.pool.pop();
    if (recycled) {
      recycled.visible = true;
      return recycled;
    }
    const g = new Graphics();
    draw(g);
    this.container.addChild(g);
    return g;
  }

  // The only rain and snow renderer — the particle registry deliberately has no
  // precipitation profiles, so each weather draws exactly one layer.
  private spawnParticles(weather: string, width: number, height: number) {
    switch (weather) {
      case "rainy":
        this.spawnRain(width, 8);
        break;
      case "stormy":
        // Rain only. Lightning belongs to LightingSystem, which flashes the
        // lightmap itself; this class used to add a second, unsynchronised
        // white overlay, so a stormy night flashed twice.
        this.spawnRain(width, 16);
        break;
      case "foggy":
        this.spawnFog(width, height, 2);
        break;
      case "snowy":
        this.spawnSnow(width, 6);
        break;
      case "windy":
        this.spawnWind(width, height, 3);
        break;
      case "hot":
        this.spawnHeat(width, height, 1);
        break;
      // sunny: nothing on purpose — a clear sky is the baseline the other weathers are read against.
      // cloudy: no particles; its drifting cloud shadows live in the world, in SkyFxSystem, so
      // they move with the terrain instead of sliding across the screen when the camera pans.
    }
  }

  private spawnRain(width: number, count: number) {
    for (let i = 0; i < count; i++) {
      const g = this.acquire((it) => {
        const length = 6 + Math.random() * 6;
        it.moveTo(0, 0).lineTo(-2, length).stroke({ color: 0x6699cc, width: 1, alpha: 0.6 });
      });
      g.x = Math.random() * width;
      g.y = -10;
      this.particles.push({
        graphic: g,
        vx: -1 - Math.random(),
        vy: 8 + Math.random() * 4,
        life: 120,
        age: 0,
      });
    }
  }

  private spawnFog(width: number, height: number, count: number) {
    for (let i = 0; i < count; i++) {
      const g = this.acquire((it) => {
        const radius = 40 + Math.random() * 60;
        it.circle(0, 0, radius).fill({ color: 0xdddddd, alpha: 0.08 });
      });
      g.x = Math.random() * width;
      g.y = Math.random() * height;
      this.particles.push({
        graphic: g,
        vx: 0.3 + Math.random() * 0.3,
        vy: -0.1 + Math.random() * 0.2,
        life: 300,
        age: 0,
      });
    }
  }

  private spawnSnow(width: number, count: number) {
    for (let i = 0; i < count; i++) {
      const g = this.acquire((it) => {
        const size = 2 + Math.random() * 3;
        it.circle(0, 0, size).fill({ color: 0xffffff, alpha: 0.7 + Math.random() * 0.3 });
      });
      g.x = Math.random() * width;
      g.y = -10;
      this.particles.push({
        graphic: g,
        vx: -0.5 + Math.random() * 1.0, // gentle drift
        vy: 1.5 + Math.random() * 1.5,   // slow fall
        life: 250,
        age: 0,
      });
    }
  }

  private spawnWind(_width: number, height: number, count: number) {
    for (let i = 0; i < count; i++) {
      const g = this.acquire((it) => {
        // Horizontal leaf/dust streak
        const len = 4 + Math.random() * 8;
        it.moveTo(0, 0).lineTo(len, -1).stroke({ color: 0x998866, width: 1.5, alpha: 0.4 });
      });
      g.x = -10;
      g.y = Math.random() * height;
      this.particles.push({
        graphic: g,
        vx: 6 + Math.random() * 4, // fast horizontal
        vy: -1 + Math.random() * 2, // slight vertical drift
        life: 120,
        age: 0,
      });
    }
  }

  private spawnHeat(width: number, height: number, count: number) {
    for (let i = 0; i < count; i++) {
      const g = this.acquire((it) => {
        // A warm band of shimmering air: wide and thin, with a fainter lip so it has no hard rim.
        const w = 40 + Math.random() * 60;
        it.rect(-w / 2, -3, w, 6).fill({ color: 0xffd080, alpha: 0.05 });
        it.rect(-w / 2 + 6, -1, w - 12, 2).fill({ color: 0xffe6a8, alpha: 0.06 });
      });
      g.x = Math.random() * width;
      g.y = height - Math.random() * (height * 0.6);
      this.particles.push({
        graphic: g,
        vx: 0,
        vy: -0.35 - Math.random() * 0.4, // rising
        life: 170,
        age: Math.random() * 6,
        wobble: { baseX: g.x, amp: 5 + Math.random() * 7, freq: 0.05 + Math.random() * 0.05 },
      });
    }
  }

  private clearParticles() {
    for (const p of this.particles) {
      p.graphic.destroy();
    }
    this.particles = [];
    // The pool has to go too: it holds the outgoing weather's shapes, and
    // `acquire` hands recycled graphics back without redrawing them, so keeping
    // it would rain snowflakes.
    for (const g of this.pool) {
      g.destroy();
    }
    this.pool = [];
  }

  destroy() {
    this.clearParticles();
    this.container.destroy({ children: true });
  }
}
