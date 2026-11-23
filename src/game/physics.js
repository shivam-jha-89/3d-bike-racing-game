// Arcade motorcycle physics in the spirit of Moto Racer (1997).
//
// The model, in one paragraph: the bike carries a scalar `speed` along a
// velocity direction that lags the visual `heading` by a slip angle. Steering
// input doesn't turn the bike directly — it sets a target LEAN angle, and yaw
// rate falls out of real coordinated-turn dynamics (yaw = g·tanφ / v). The
// tyres can only supply `grip · g` of lateral acceleration; ask for more and
// the surplus becomes understeer, growing slip angle (the back steps out) and
// speed scrub. Rear brake deliberately over-rotates for powerslides. Vertical
// motion follows the track surface until the ground falls away faster than
// gravity — which is exactly what launches you off tabletops and whoops.

export const G = 9.81;

const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const wrapAngle = (a) => Math.atan2(Math.sin(a), Math.cos(a));

export class BikePhysics {
  constructor(bike, track) {
    this.track = track;
    const mod = track.def.bikeMods[bike.type];
    // bike spec adjusted for this track's racing surface
    this.spec = {
      topSpeed: bike.topSpeed * mod.topSpeed,
      accel: bike.accel * mod.accel,
      brake: bike.brake,
      grip: bike.grip * mod.grip,
      maxLean: bike.maxLean,
      leanSpeed: bike.leanSpeed,
    };
    this.dirt = track.def.surface === 'dirt';

    // state
    this.x = 0; this.y = 0; this.z = 0;
    this.vy = 0;
    this.prevGy = 0;
    this.airborne = false;
    this.heading = 0;
    this.speed = 0;
    this.lean = 0;       // roll angle, +ve = leaning into a left turn
    this.visLean = 0;    // rendered roll: derived from actual cornering force
    this.slip = 0;       // angle between heading and velocity direction
    this.wheelie = 0;    // pitch-up angle
    this.pitch = 0;      // total visual pitch (wheelie + terrain + air)
    this.crashed = false;
    this.crashTimer = 0;
    this.stunTimer = 0;  // shot by an opponent: steering scrambled
    this.stunPhase = 0;
    this.hintIdx = null;

    // per-step telemetry for game/audio/fx
    this.info = { onRoad: true, sliding: 0, s: 0, lateral: 0, gear: 1, rpm: 0, landed: 0, crashedNow: false };
  }

  placeAt(s, lateral) {
    const sm = this.track.sampleAt(s);
    this.x = sm.x + sm.nx * lateral;
    this.z = sm.z + sm.nz * lateral;
    this.heading = sm.angle;
    this.speed = 0; this.vy = 0; this.lean = 0; this.slip = 0;
    this.visLean = 0; this.wheelie = 0; this.airborne = false;
    this.stunTimer = 0;
    this.hintIdx = null;
    const q = this.track.nearest(this.x, this.z, null);
    this.hintIdx = q.index;
    this.info.s = q.s;
    // ground height at the PROJECTED s — the same value the next step's
    // terrain-following will see, so spawning on a slope doesn't create a
    // phantom height delta
    this.y = this.track.heightAt(q.s);
    this.prevGy = this.y;
  }

  respawn() {
    const q = this.track.nearest(this.x, this.z, this.hintIdx);
    this.crashed = false;
    this.crashTimer = 0;
    this.placeAt(q.s, 0);
  }

  terrainVy(gy, dt) {
    const raw = (gy - this.prevGy) / dt;
    const cap = Math.abs(this.speed) * 0.6 + 1;
    return Math.min(cap, Math.max(-cap, raw));
  }

  // crest take-off test: does holding the ground here demand more downward
  // acceleration than gravity provides? (v² x local downward curvature > g)
  launchCheck(s, gy) {
    const v = this.speed;
    if (Math.abs(v) < 9) return false; // walking pace never launches
    const H = 2.5; // slope sampling half-window in metres
    const hBack = this.track.heightAt(Math.max(0, s - H));
    const hFwd = this.track.heightAt(s + H);
    const slopeBack = (gy - hBack) / H;   // face we rode up
    const slopeFwd = (hFwd - gy) / H;     // face falling away ahead
    // the two slope midpoints sit H apart, so the second derivative is
    // their difference over H (dividing by 2H halves the real curvature)
    const curvDown = (slopeBack - slopeFwd) / H; // >0 over a crest
    if (curvDown * v * v > G * 1.15) {
      // fly off along the take-off face's tangent
      this.vy = Math.max(this.vy, slopeBack * Math.abs(v));
      return true;
    }
    return false;
  }

  stun(d) {
    this.stunTimer = Math.max(this.stunTimer, d);
  }

  crash() {
    this.crashed = true;
    this.crashTimer = 1.7;
    this.crashSpeed = this.speed; // the ragdoll launches with this
    this.speed = 0;
    this.info.crashedNow = true;
  }

  step(input, dt) {
    this.info.crashedNow = false;
    this.info.landed = 0;

    if (this.crashed) {
      this.crashTimer -= dt;
      if (this.crashTimer <= 0) this.respawn();
      return;
    }

    const stunned = this.stunTimer > 0;
    if (stunned) {
      this.stunTimer -= dt;
      this.stunPhase += dt;
    }

    const q = this.track.nearest(this.x, this.z, this.hintIdx);
    this.hintIdx = q.index;
    const onRoad = Math.abs(q.lateral) <= this.track.halfWidth + 0.6;
    const off = this.track.def.offroad;

    const grip = this.spec.grip * (onRoad ? 1 : off.grip);
    const maxLat = grip * G;
    const topSpeed = this.spec.topSpeed * (onRoad ? 1 : off.topSpeed);

    // ---------------------------------------------------- longitudinal
    const v = this.speed;
    const absV = Math.abs(v);
    // torque tapers as we approach terminal velocity for this surface
    const accelAvail = this.spec.accel * Math.max(0, 1 - Math.pow(Math.max(0, v) / topSpeed, 3));
    let drive = input.throttle * accelAvail;
    // friction ellipse: the tyre splits its grip between cornering and
    // drive — leaned over, less thrust reaches the road, so the bike
    // genuinely slows through a hard corner even with the gas pinned
    if (!this.airborne && absV > 2) {
      const latFrac = Math.min(1, (G * Math.tan(Math.abs(this.lean))) / maxLat);
      // softened ellipse: even at full lean ~half the thrust still works —
      // arcade forgiveness over strict physics
      drive *= 0.5 + 0.5 * Math.sqrt(Math.max(0, 1 - latFrac * latFrac));
    }
    if (this.airborne) drive = 0;
    if (this.wheelie > 0.3) drive *= 0.92; // front's in the air, short-shift a bit
    if (stunned) drive *= 0.55; // can't hold the throttle steady while hit

    let a = drive;
    a -= 0.0011 * v * absV + 0.4 * Math.sign(v); // aero drag + rolling resistance
    // slipstream: tucked in behind another bike, the hole in the air gives
    // back up to ~45% of aero drag — the classic tow for an overtake
    if (this.draft > 0) a += 0.0011 * v * absV * 0.45 * this.draft;
    // tyre scrub: cornering itself costs speed (slip angles burn energy)
    if (!this.airborne && absV > 2) {
      a -= G * Math.tan(Math.abs(this.lean)) * 0.022 * Math.sign(v || 1);
    }
    if (!onRoad && !this.airborne) a -= off.drag * absV * Math.sign(v || 1);
    if (!this.airborne) {
      // front brake: strong, scaled by available grip
      if (input.brake > 0 && v > 0.1) a -= input.brake * this.spec.brake * (0.35 + 0.65 * Math.min(1, grip));
      // rear brake: weaker stopper, but see the slide logic below
      if (input.rear && v > 0.1) a -= 3.5;
    } else {
      a = -0.15; // just air drag
    }
    this.speed = v + a * dt;
    // crawling reverse so you can escape a wall without the reset key
    if (v <= 0.1 && input.brake > 0.5 && !this.airborne) {
      this.speed = clamp(this.speed - 3 * dt, -3, 0.1);
    } else if (this.speed < 0) {
      this.speed = Math.min(this.speed + 6 * dt, 0);
    }
    if (input.throttle === 0 && input.brake === 0 && absV < 0.3) this.speed = 0;

    // ---------------------------------------------------- lean & yaw
    // Lean authority builds with speed (no knee-dragging at parking pace),
    // and usable lean is capped by what the tyres can actually hold:
    // gripLean is the roll angle whose cornering demand exactly equals
    // maxLat. On asphalt the cap sits at ~the grip limit, so full lock means
    // cornering AT the limit — planted, no sideways skating. On dirt the
    // bike's max lean exceeds its grip, so the rear naturally works loose.
    const gripLean = Math.atan(maxLat / G);
    // asphalt barely overshoots the grip limit (glued to the road); dirt
    // keeps a proper margin of looseness
    const leanCap = Math.min(this.spec.maxLean, gripLean * (this.dirt ? 1.1 : 1.035));
    const auth = 0.25 + 0.75 * Math.min(1, absV / 14);
    let targetLean = input.steer * leanCap * auth;
    if (this.airborne) targetLean *= 0.25;
    // one hand off the bars (pistol drawn): far less lean, and slower to get it
    if (input.oneHanded) targetLean *= 0.55;
    if (stunned) targetLean *= 0.2; // shot: barely any steering authority
    const lr = this.spec.leanSpeed * (input.oneHanded ? 0.7 : 1) * dt;
    this.lean += clamp(targetLean - this.lean, -lr, lr);

    // coordinated-turn yaw from lean, blended with kinematic steer at low speed
    const yawLean = (G * Math.tan(this.lean)) / Math.max(absV, 4);
    const yawKin = input.steer * 1.35 * clamp(this.speed / 8, -1, 1);
    const blend = clamp((absV - 3) / 6, 0, 1);
    let yaw = yawKin * (1 - blend) + yawLean * blend * Math.sign(this.speed || 1);

    // ---------------------------------------------------- traction circle
    let slideAmt = 0;
    let targetSlip = 0;
    const need = Math.abs(this.speed * yaw);
    if (need > maxLat && absV > 2 && !this.airborne) {
      const ratio = maxLat / need;
      slideAmt = 1 - ratio;
      yaw *= 0.5 + 0.5 * ratio; // understeer: you don't get the full rotation
      // how far the rear steps out is a property of the surface: a couple of
      // degrees on asphalt, a proper drift angle on dirt, worse on grass
      const maxSlip = onRoad ? (this.dirt ? 0.34 : 0.06) : 0.5;
      targetSlip = Math.sign(yaw) * Math.min(slideAmt * 2.5, 1) * maxSlip;
      // scrubbing speed: sliding tyres are slow tyres
      this.speed -= Math.min((need - maxLat) * 0.4, 6) * dt * Math.sign(this.speed || 1);
    }
    // rear-brake powerslide: kick the tail, over-rotate toward the steer.
    // This is the ONLY way to get a big slide on asphalt — you have to ask.
    if (input.rear && !this.airborne && absV > 6 && Math.abs(input.steer) > 0.1) {
      yaw *= 1.45;
      targetSlip += Math.sign(input.steer) * 0.3;
      slideAmt = Math.max(slideAmt, 0.5);
    }
    if (this.wheelie > 0.2) yaw *= 1 - 0.55 * Math.min(1, this.wheelie / 0.5);
    if (this.airborne) { yaw *= 0.15; }
    // wobble while stunned: a slower, subtler weave (alternates, so the net
    // path holds roughly straight, and the traction circle scrubs a little
    // speed off each swing)
    if (stunned && !this.airborne) yaw += Math.sin(this.stunPhase * 10) * 0.32;

    // slip relaxes toward its target; asphalt snaps back, loose surfaces
    // hold the drift
    const tau = onRoad ? (this.dirt ? 0.22 : 0.07) : 0.35;
    this.slip += (targetSlip - this.slip) * Math.min(1, dt / tau);

    // Visual lean is derived from the yaw we ACTUALLY got, not the input:
    // atan(v·yaw / g) is the roll that balances the real cornering force, so
    // understeer visibly stands the bike up, and on loose ground the slip
    // angle lays it over into the drift.
    let visTarget;
    if (this.airborne) {
      visTarget = this.lean * 0.6;
    } else {
      visTarget = Math.atan2(this.speed * yaw, G) + this.slip * (this.dirt || !onRoad ? 0.9 : 0.5);
    }
    this.visLean += (visTarget - this.visLean) * Math.min(1, dt * 9);

    this.heading = wrapAngle(this.heading + yaw * dt);

    // ---------------------------------------------------- integrate position
    const moveDir = this.heading - this.slip;
    this.x += Math.sin(moveDir) * this.speed * dt;
    this.z += Math.cos(moveDir) * this.speed * dt;

    // ---------------------------------------------------- wheelie / stoppie
    const wantWheelie =
      !this.airborne && input.throttle > 0.85 && this.speed > 2 &&
      this.speed < 0.42 * topSpeed && drive > 6 && Math.abs(input.steer) < 0.5;
    const wTarget = wantWheelie ? 0.5 : 0;
    this.wheelie += (wTarget - this.wheelie) * Math.min(1, dt * (wantWheelie ? 2.0 : 5.0));
    let pitch = -this.wheelie;
    if (!this.airborne && input.brake > 0.7 && this.speed > 12) pitch += 0.06; // stoppie dip

    // ---------------------------------------------------- vertical / jumps
    const q2 = this.track.nearest(this.x, this.z, this.hintIdx);
    this.hintIdx = q2.index;
    const gy = this.track.heightAt(q2.s);
    this.vy -= G * dt;
    this.y += this.vy * dt;
    if (this.y <= gy) {
      if (this.airborne) {
        // landing
        const impact = -this.vy;
        this.info.landed = impact;
        if (impact > 13) { this.y = gy; this.crash(); return; }
        if (impact > 7) this.speed *= 0.88;
        this.airborne = false;
      }
      // follow terrain — UNLESS this is a genuine take-off. Real physics:
      // over a crest the ground curves away beneath you; staying glued
      // demands downward acceleration of v² x curvature. The moment that
      // exceeds gravity, the wheels can't be held down — you fly. Slope is
      // sampled a few metres either side so the piecewise-linear terrain
      // doesn't spike the estimate at mesh vertices, and v² makes speed
      // the deciding factor: the same hump is nothing at 60 and a launch
      // at 140.
      if (this.launchCheck(q2.s, gy)) {
        this.y = gy;
        this.airborne = true; // vy already set to the take-off slope
      } else {
        this.y = gy;
        this.vy = this.terrainVy(gy, dt);
      }
    } else if (this.y > gy + 0.06) {
      this.airborne = true;
    } else {
      // a freshly-launched bike sits millimetres over the ground for a few
      // steps — re-glueing it here would kill every gentle crest jump, so
      // once ballistic it stays ballistic until it actually touches down
      if (this.airborne || this.launchCheck(q2.s, gy)) {
        this.airborne = true;
      } else {
        this.y = gy;
        this.vy = this.terrainVy(gy, dt);
      }
    }
    this.prevGy = gy;
    // nose follows the flight arc: rising = nose up (negative x-rotation)
    if (this.airborne) pitch += clamp(Math.atan2(-this.vy, Math.max(absV, 8)) * 0.6, -0.3, 0.35);
    this.pitch = pitch;

    // ---------------------------------------------------- barriers
    // corridor narrows inside tunnels, on bridge decks, and against
    // guardrails — which only exist on one side, hence per-side limits
    const smp0 = q2.sample;
    const wd = (q2.lateral >= 0 ? smp0.wallL : smp0.wallR)
      ?? (smp0.wallD || this.track.wallDist);
    if (Math.abs(q2.lateral) > wd) {
      const sm = q2.sample;
      const sign = Math.sign(q2.lateral);
      // shove back inside the wall
      const overshoot = q2.lateral - sign * wd;
      this.x -= sm.nx * overshoot;
      this.z -= sm.nz * overshoot;
      // impact severity = lateral component of velocity
      const impactAngle = wrapAngle(moveDir - sm.angle);
      const latSpeed = Math.abs(this.speed * Math.sin(impactAngle));
      // only a grounded (or near-ground) hit can throw you off the bike;
      // clipping the barrier mid-flight is a glance, not a crash
      if (latSpeed > 11 && this.y < gy + 1.4) { this.crash(); return; }
      this.speed *= 1 - 0.55 * clamp(latSpeed / 11, 0, 1);
      // glance off: pull heading toward the wall's direction
      const along = wrapAngle(sm.angle - this.heading);
      this.heading = wrapAngle(this.heading + along * 0.5);
      this.slip *= 0.3;
      this.lean *= 0.5;
    }

    // ---------------------------------------------------- telemetry
    this.info.onRoad = onRoad;
    this.info.sliding = slideAmt;
    this.info.s = q2.s;
    this.info.lateral = q2.lateral;
    const frac = clamp(Math.max(0, this.speed) / this.spec.topSpeed, 0, 1);
    // fake 5-speed box for the tach and engine audio
    const shifts = [0, 0.13, 0.27, 0.45, 0.67, 1.001];
    let gear = 1;
    for (let i = 1; i < shifts.length; i++) {
      if (frac >= shifts[i - 1] && frac < shifts[i]) { gear = i; break; }
      if (frac >= 1) gear = 5;
    }
    const lo = shifts[gear - 1], hi = shifts[gear];
    this.info.gear = this.speed < 0.5 ? 1 : gear;
    this.info.rpm = this.speed < 0.5
      ? input.throttle * 0.5
      : clamp(0.25 + 0.75 * ((frac - lo) / (hi - lo)), 0, 1);
  }
}
