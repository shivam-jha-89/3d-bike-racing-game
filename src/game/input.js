// Keyboard state -> analog-ish input object the physics consumes.
// Steering ramps rather than snapping so keyboard play feels progressive.

export class Input {
  constructor() {
    this.keys = new Set();
    this.state = { throttle: 0, brake: 0, steer: 0, rear: false, reset: false, oneHanded: false };
    this.mouse = { x: 0, y: 0 };
    // on-screen sticks write here (TouchControls); merged in update()
    this.touch = { steer: 0, throttle: 0, brake: 0, focus: false };
    this.onLeftClick = null;  // fire
    this.onRightClick = null; // draw / holster
    this.fireHeld = false;    // true while the left button is down (auto weapons)
    this._down = (e) => {
      if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', ' '].includes(e.key)) e.preventDefault();
      this.keys.add(e.key.length === 1 ? e.key.toLowerCase() : e.key);
    };
    this._up = (e) => {
      this.keys.delete(e.key.length === 1 ? e.key.toLowerCase() : e.key);
    };
    this._mm = (e) => {
      this.mouse.x = e.clientX;
      this.mouse.y = e.clientY;
    };
    this._md = (e) => {
      if (e.button === 2) this.onRightClick && this.onRightClick();
      else if (e.button === 0) {
        this.fireHeld = true;
        this.onLeftClick && this.onLeftClick();
      }
    };
    this._mu = (e) => {
      if (e.button === 0) this.fireHeld = false;
    };
    this._ctx = (e) => e.preventDefault(); // right-click is a game button now
  }

  attach() {
    window.addEventListener('keydown', this._down);
    window.addEventListener('keyup', this._up);
    window.addEventListener('mousemove', this._mm);
    window.addEventListener('mousedown', this._md);
    window.addEventListener('mouseup', this._mu);
    window.addEventListener('contextmenu', this._ctx);
    window.addEventListener('blur', this._blur = () => {
      this.keys.clear();
      this.fireHeld = false;
    });
  }

  detach() {
    window.removeEventListener('keydown', this._down);
    window.removeEventListener('keyup', this._up);
    window.removeEventListener('mousemove', this._mm);
    window.removeEventListener('mousedown', this._md);
    window.removeEventListener('mouseup', this._mu);
    window.removeEventListener('contextmenu', this._ctx);
    window.removeEventListener('blur', this._blur);
  }

  has(...ks) {
    return ks.some((k) => this.keys.has(k));
  }

  update(dt) {
    const s = this.state;
    const throttleOn = this.has('ArrowUp', 'w');
    const brakeOn = this.has('ArrowDown', 's');
    // the stick is analog: no ramp, its deflection IS the value
    s.throttle = throttleOn ? Math.min(1, s.throttle + dt * 5) : this.touch.throttle;
    s.brake = brakeOn ? Math.min(1, s.brake + dt * 6) : this.touch.brake;
    // steer: +1 is LEFT (positive yaw in our convention)
    const dir = (this.has('ArrowLeft', 'a') ? 1 : 0) + (this.has('ArrowRight', 'd') ? -1 : 0);
    if (dir !== 0) {
      s.steer += dir * dt * 4.5;
      if (Math.sign(s.steer) !== Math.sign(dir)) s.steer += dir * dt * 6; // faster crossover
    } else if (Math.abs(this.touch.steer) > 0.02) {
      s.steer = this.touch.steer;
    } else {
      const back = dt * 6;
      s.steer = Math.abs(s.steer) <= back ? 0 : s.steer - Math.sign(s.steer) * back;
    }
    s.steer = Math.max(-1, Math.min(1, s.steer));
    s.rear = this.has(' ');
    s.reset = this.has('r');
    return s;
  }
}
