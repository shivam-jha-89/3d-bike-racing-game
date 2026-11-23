// AI riders: kinematic spline followers with a corner-speed lookahead
// (v = sqrt(a_lat / |curvature|), backed off by braking distance) and a mild
// Moto Racer-style rubber band so the pack stays interesting.

const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

export class AIRider {
  constructor(track, bike, { skill = 0.93, startS = 0, startLat = 0 } = {}) {
    // armour: a full pistol charge minus one shot strips it (4 x 25),
    // only then do hits stun — riders fight back longer now
    this.armorMax = 100;
    this.armor = this.armorMax;
    this.armorRegenDelay = 0;
    // life underneath the plate — at zero the rider is out of the stage
    this.hpMax = 100;
    this.hp = this.hpMax;
    // elemental status timers (incendiary / shock / cryo)
    this.burnT = 0;
    this.burnDps = 0;
    this.shockLock = 0;
    this.slowT = 0;
    this.track = track;
    const mod = track.def.bikeMods[bike.type];
    this.vmax = bike.topSpeed * mod.topSpeed * 0.97;
    this.maxLat = bike.grip * mod.grip * 9.81 * 0.92;
    this.accel = bike.accel * mod.accel * 0.9;
    this.decel = bike.brake * 0.55;
    this.skill = skill;
    this.s = startS;
    this.progress = startS; // A->B stage: progress IS the track position
    this.speed = 0;
    this.lateral = startLat;
    this.baseLat = startLat;
    this.lean = 0;
    this.wanderPhase = Math.abs(startLat) * 7 + skill * 20;
    this.finishTime = null;
    this.stunTimer = 0;
    this.stunPhase = 0;
    this.aiming = false; // pistol out: one hand on the bars, less cornering
    this.latVel = 0; // sideways speed — drives the visual heading
    // throttle hand: rolls back on after a hit instead of snapping to full
    this.throttleRamp = 1;
    // vertical state: AI take jumps ballistically, same rule as the player
    this.y = 0;
    this.vy = 0;
    this.airborne = false;
    this.prevGy = null;
  }

  // grounded: follow the terrain — unless it drops away faster than gravity
  // can pull us (a crest at speed), then fly a ballistic arc and land
  updateVertical(dt) {
    const gy = this.track.heightAt(this.s);
    if (this.prevGy === null) this.prevGy = gy;
    if (!this.airborne) {
      const tvy = (gy - this.prevGy) / dt;
      const eps = Math.max(0.6, 0.022 * this.speed);
      if (tvy < this.vy - 9.81 * dt - eps && this.speed > 12) {
        this.airborne = true; // launched
        this.y = Math.max(this.y, gy);
      } else {
        this.vy = Math.abs(tvy) > 30 ? 0 : tvy; // teleport guard
        this.y = gy;
      }
    } else {
      this.vy -= 9.81 * dt;
      this.y += this.vy * dt;
      if (this.y <= gy) {
        this.y = gy;
        this.airborne = false;
      }
    }
    this.prevGy = gy;
  }

  // shot by the player: no steering for `d` seconds
  stun(d) {
    this.stunTimer = Math.max(this.stunTimer, d);
  }

  // weapon damage routes through the plate first, then starts draining
  // life. Returns 'armor' (clang), 'hit' (stunned, bleeding) or 'dead'.
  takeHit(dmg, stunDur, type) {
    this.armorRegenDelay = 6;
    if (this.armor >= 1) {
      // corrosive dissolves plate twice as fast, then bites flesh gently
      const aDmg = type === 'corrosive' ? dmg * 2 : dmg;
      const spill = aDmg - this.armor; // what's left after the plate cracks
      this.armor = Math.max(0, this.armor - aDmg);
      if (spill <= 0) return 'armor';
      // the hit broke through mid-swing: the remainder bites flesh
      this.hp = Math.max(0, this.hp - (type === 'corrosive' ? spill * 0.25 : spill));
      this.stun(stunDur * 0.6);
      return this.hp <= 0 ? 'dead' : 'hit';
    }
    this.hp = Math.max(0, this.hp - (type === 'corrosive' ? dmg * 0.5 : dmg));
    this.stun(stunDur);
    return this.hp <= 0 ? 'dead' : 'hit';
  }

  step(dt, leaderProgress, raceT) {
    // elemental aftereffects tick in both branches (stunned or riding).
    // Burn never kills: elimination stays exclusive to the aiHit funnel so
    // contract credit and the RIDER OUT flow need no special cases.
    if (this.burnT > 0) {
      this.burnT -= dt;
      // drain toward the 1 hp floor, never up to it — a rider already under
      // it (fractional spill math) must not be healed by catching fire
      if (this.hp > 1) this.hp = Math.max(1, this.hp - this.burnDps * dt);
      this.armorRegenDelay = Math.max(this.armorRegenDelay, 0.5);
    }
    if (this.shockLock > 0) this.shockLock -= dt;
    if (this.slowT > 0) this.slowT -= dt;
    // armour knits back together once nobody has tagged them for a while
    if (this.armorRegenDelay > 0) this.armorRegenDelay -= dt;
    else this.armor = Math.min(this.armorMax, this.armor + 3 * dt);
    const track = this.track;
    const prevLat = this.lateral;

    if (this.stunTimer > 0) {
      // hands off the bars: coast with a tank-slapper wobble, drifting to
      // the outside of whatever bend the track is making
      this.stunTimer -= dt;
      this.stunPhase += dt;
      const sm = track.interpAt(this.s);
      this.speed = Math.max(this.speed - 8 * dt, 5);
      // centrifugal drift to the OUTSIDE of the bend (curv > 0 = right turn,
      // outside = +lateral/left)
      this.lateral += sm.curv * this.speed * this.speed * dt * 1.5;
      const limL = (sm.wallL ?? sm.wallD ?? track.wallDist) - 1.2;
      const limR = (sm.wallR ?? sm.wallD ?? track.wallDist) - 1.2;
      if (this.lateral > limL || this.lateral < -limR) {
        this.lateral = clamp(this.lateral, -limR, limL);
        this.speed = Math.max(this.speed - 14 * dt, 4); // scraping the barrier
      } else if (Math.abs(this.lateral) > track.halfWidth) {
        this.speed = Math.max(this.speed - 7 * dt, 4); // on the grass
      }
      this.lean = Math.sin(this.stunPhase * 9) * 0.25;
      this.throttleRamp = 0.2; // hands off the bars: no drive to roll on yet
      const dp = this.speed * dt;
      this.s = Math.min(this.s + dp, track.length - 4);
      this.progress += dp;
      if (this.finishTime === null && this.progress >= track.finishS) {
        this.finishTime = raceT;
      }
      this.latVel += ((this.lateral - prevLat) / dt - this.latVel) * Math.min(1, dt * 8);
      this.updateVertical(dt);
      return;
    }

    // corner-speed lookahead over the next ~160 m. Aiming costs grip: one
    // hand on the bars means the same lean-restriction rule the player has.
    let allowed = this.vmax;
    const latCap = this.aiming ? this.maxLat * 0.6 : this.maxLat;
    for (let d = 0; d < 160; d += 8) {
      const sm = track.sampleAt(this.s + d + this.speed * 0.15);
      const vc = Math.sqrt(latCap / Math.max(Math.abs(sm.curv), 1e-4));
      allowed = Math.min(allowed, Math.sqrt(vc * vc + 2 * this.decel * d));
    }
    if (this.slowT > 0) allowed *= 0.65; // cryo: the engine ices over

    // mild rubber band only — pacing comes from calibrated skill, and a
    // strong band would erase the field spread
    const gap = leaderProgress - this.progress; // metres behind the leader
    const rb = clamp(1 + gap * 0.0004, 0.97, 1.05);
    let target = Math.min(allowed * this.skill * rb, this.vmax * 1.03);
    // past the finish line: cruise out and pull up before the road ends
    if (this.progress > track.finishS) target = Math.min(target, 10);

    // Longitudinal envelope — the same shape the player rides under
    // (physics.js). AI stay kinematic (they pick a target speed and hold a
    // line), but they no longer BUY that speed for free: torque tapers
    // toward terminal, air pushes back, and a leaned-over bike puts less
    // thrust on the road. Without this they pulled 7x the player's
    // acceleration at 230 km/h and could cruise past the player's
    // drag-imposed ceiling.
    const v = this.speed;
    if (v < target) {
      // throttle rolls back on after a hit rather than snapping to full
      this.throttleRamp = Math.min(1, this.throttleRamp + dt * 0.9);
      // torque tapers as the bike approaches its terminal velocity
      let drive = this.accel * Math.max(0, 1 - Math.pow(Math.max(0, v) / this.vmax, 3));
      // friction ellipse: grip spent on cornering isn't available to drive.
      // Softened the same way the player's is — half the thrust survives
      // full lean, arcade forgiveness over strict physics.
      if (v > 2) {
        const latFrac = Math.min(1, (9.81 * Math.tan(Math.abs(this.lean))) / latCap);
        drive *= 0.5 + 0.5 * Math.sqrt(Math.max(0, 1 - latFrac * latFrac));
      }
      drive *= this.throttleRamp;
      const a = drive - (0.0011 * v * v + 0.4); // aero drag + rolling resistance
      this.speed = Math.min(target, Math.max(0, v + a * dt));
    } else {
      this.throttleRamp = Math.min(1, this.throttleRamp + dt * 0.9);
      this.speed = Math.max(target, v - this.decel * 1.4 * dt);
    }

    const dp = this.speed * dt;
    this.s = Math.min(this.s + dp, track.length - 4);
    this.progress += dp;

    // line: drift toward the inside of upcoming corners + slow personal wander
    // (curv sign: NEGATIVE for left turns; inside of a left turn is +lateral)
    this.wanderPhase += dt * 0.4;
    const ahead = track.sampleAt(this.s + 25);
    const inside = clamp(-ahead.curv * 900, -1, 1) * (track.halfWidth - 2.5);
    const wander = Math.sin(this.wanderPhase) * 1.5;
    const targetLat = clamp(inside + this.baseLat * 0.4 + wander,
      -(track.halfWidth - 1.5), track.halfWidth - 1.5);
    // line changes are STEERED, not slid: lateral velocity accelerates
    // toward the target under a lateral-g budget (a slice of the same grip
    // the corner model spends), so every move arcs like countersteering
    // instead of a constant-rate rail glide
    const latErr = targetLat - this.lateral;
    const speedFac = clamp(this.speed / 16, 0, 1);
    const maxLatV = (1.0 + 0.14 * this.speed) * speedFac;
    const maxLatA = (latCap * 0.45 + 0.6) * speedFac + 0.2;
    const wantV = clamp(latErr * 1.4, -maxLatV, maxLatV);
    const prevLatVel = this.latVel;
    this.latVel += clamp(wantV - this.latVel, -maxLatA * dt, maxLatA * dt);
    this.lateral += this.latVel * dt;
    const latAcc = (this.latVel - prevLatVel) / dt;

    // lean from BOTH cornering and the line-change g — a bike banks into a
    // lateral move, it doesn't slide flat. (curv < 0 = left turn; lean > 0
    // = leaning left; +latVel is a leftward move.)
    const sm = track.interpAt(this.s);
    const targetLean = clamp(
      Math.atan2(-this.speed * this.speed * sm.curv + latAcc * 0.8, 9.81), -0.9, 0.9);
    this.lean += (targetLean - this.lean) * Math.min(1, dt * 6);

    if (this.finishTime === null && this.progress >= track.finishS) {
      this.finishTime = raceT;
    }
    this.updateVertical(dt);
  }

  pose() {
    // interpolated, NOT nearest-sample — this is what keeps AI motion smooth
    const sm = this.track.interpAt(this.s);
    return {
      x: sm.x + sm.nx * this.lateral,
      y: this.airborne ? this.y : sm.y,
      z: sm.z + sm.nz * this.lateral,
      // heading follows the ACTUAL velocity (forward + lateral), so line
      // changes read as steering instead of a sideways pull (fades out at
      // standstill so grid bikes sit straight)
      heading: sm.angle + clamp(Math.atan2(this.latVel, Math.max(this.speed, 2)), -0.45, 0.45) *
        clamp(this.speed / 5, 0, 1),
      lean: this.lean,
    };
  }
}
