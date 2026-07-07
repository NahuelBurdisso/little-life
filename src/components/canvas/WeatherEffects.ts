import { Application, Container, Graphics } from "pixi.js";

interface Particle {
  graphic: Graphics;
  vx: number;
  vy: number;
  life: number;
}

export class WeatherEffects {
  container: Container;
  private particles: Particle[] = [];
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
      p.graphic.x += p.vx * delta;
      p.graphic.y += p.vy * delta;
      p.life -= delta;

      if (p.life <= 0 || p.graphic.y > height + 20 || p.graphic.x > width + 20) {
        p.graphic.destroy();
        this.particles.splice(i, 1);
      }
    }
  }

  private spawnParticles(weather: string, width: number, height: number) {
    switch (weather) {
      case "rainy":
        this.spawnRain(width, 8);
        break;
      case "stormy":
        this.spawnRain(width, 16);
        // Occasional lightning flash
        if (Math.random() < 0.05) {
          this.flashLightning(width, height);
        }
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
      // sunny, cloudy: no particles
    }
  }

  private spawnRain(width: number, count: number) {
    for (let i = 0; i < count; i++) {
      const g = new Graphics();
      const x = Math.random() * width;
      const length = 6 + Math.random() * 6;
      g.moveTo(0, 0).lineTo(-2, length).stroke({ color: 0x6699cc, width: 1, alpha: 0.6 });
      g.x = x;
      g.y = -10;
      this.container.addChild(g);
      this.particles.push({
        graphic: g,
        vx: -1 - Math.random(),
        vy: 8 + Math.random() * 4,
        life: 120,
      });
    }
  }

  private spawnFog(width: number, height: number, count: number) {
    for (let i = 0; i < count; i++) {
      const g = new Graphics();
      const radius = 40 + Math.random() * 60;
      g.circle(0, 0, radius).fill({ color: 0xdddddd, alpha: 0.08 });
      g.x = Math.random() * width;
      g.y = Math.random() * height;
      this.container.addChild(g);
      this.particles.push({
        graphic: g,
        vx: 0.3 + Math.random() * 0.3,
        vy: -0.1 + Math.random() * 0.2,
        life: 300,
      });
    }
  }

  private flashLightning(width: number, height: number) {
    const flash = new Graphics();
    flash.rect(0, 0, width, height).fill({ color: 0xffffff, alpha: 0.3 });
    this.container.addChild(flash);
    this.particles.push({
      graphic: flash,
      vx: 0,
      vy: 0,
      life: 3,
    });
  }

  private spawnSnow(width: number, count: number) {
    for (let i = 0; i < count; i++) {
      const g = new Graphics();
      const size = 2 + Math.random() * 3;
      g.circle(0, 0, size).fill({ color: 0xffffff, alpha: 0.7 + Math.random() * 0.3 });
      g.x = Math.random() * width;
      g.y = -10;
      this.container.addChild(g);
      this.particles.push({
        graphic: g,
        vx: -0.5 + Math.random() * 1.0, // gentle drift
        vy: 1.5 + Math.random() * 1.5,   // slow fall
        life: 250,
      });
    }
  }

  private spawnWind(_width: number, height: number, count: number) {
    for (let i = 0; i < count; i++) {
      const g = new Graphics();
      // Horizontal leaf/dust streak
      const len = 4 + Math.random() * 8;
      g.moveTo(0, 0).lineTo(len, -1).stroke({ color: 0x998866, width: 1.5, alpha: 0.4 });
      g.x = -10;
      g.y = Math.random() * height;
      this.container.addChild(g);
      this.particles.push({
        graphic: g,
        vx: 6 + Math.random() * 4, // fast horizontal
        vy: -1 + Math.random() * 2, // slight vertical drift
        life: 120,
      });
    }
  }

  private spawnHeat(width: number, height: number, count: number) {
    for (let i = 0; i < count; i++) {
      const g = new Graphics();
      // Rising heat shimmer
      const w = 20 + Math.random() * 30;
      g.rect(-w / 2, -2, w, 4).fill({ color: 0xffcc66, alpha: 0.06 });
      g.x = Math.random() * width;
      g.y = height - Math.random() * (height * 0.3);
      this.container.addChild(g);
      this.particles.push({
        graphic: g,
        vx: Math.sin(g.y * 0.1) * 0.3, // wavering
        vy: -0.3 - Math.random() * 0.3, // rising
        life: 200,
      });
    }
  }

  private clearParticles() {
    for (const p of this.particles) {
      p.graphic.destroy();
    }
    this.particles = [];
  }

  destroy() {
    this.clearParticles();
    this.container.destroy({ children: true });
  }
}
