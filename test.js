// node test.js — checks the keyframe simplifier and mouse spring without Cavalry.
const assert = require("assert");
eval(require("fs").readFileSync(__dirname + "/ScreenStudioToCavalry.js", "utf8"));

// Hold at 0, ramp to 40, hold: only the corners should survive.
const s = [];
for (let f = 0; f <= 60; f++) s.push({ f, v: [f < 20 ? 0 : f < 40 ? (f - 20) * 2 : 40] });
const kept = simplify(s, 0.5).map(x => x.f);
assert.deepStrictEqual(kept, [0, 20, 40, 60]);

// Every dropped sample must be within tolerance of the linear curve through kept keys.
function maxErr(samples, keys) {
    let worst = 0, j = 0;
    for (const p of samples) {
        while (keys[j + 1] && keys[j + 1].f < p.f) j++;
        const a = keys[j], b = keys[j + 1] || a, u = b.f === a.f ? 0 : (p.f - a.f) / (b.f - a.f);
        p.v.forEach((v, c) => { worst = Math.max(worst, Math.abs(v - (a.v[c] + (b.v[c] - a.v[c]) * u))); });
    }
    return worst;
}
const noisy = [];
for (let f = 0; f <= 500; f++) noisy.push({ f, v: [Math.round(Math.sin(f / 20) * 100), Math.round(f * 1.7) % 90] });
const k2 = simplify(noisy, 1);
assert(maxErr(noisy, k2) <= 1, "exceeds tolerance");
assert(k2.length < noisy.length / 2, "barely simplified: " + k2.length);

// Spring: a jump from 0 to 100 at t=0.5s should lag, then settle on the target without big overshoot.
const moves = [{ t: 0, x: 0, y: 0 }, { t: 0.5, x: 100, y: -50 }];
const sp = mousePath(moves, 30, 60, { stiffness: 470, damping: 70, mass: 3 });
assert(sp[16][0] > 0 && sp[16][0] < 50, "should lag behind the jump: " + sp[16][0]);
assert(Math.abs(sp[60][0] - 100) < 0.5 && Math.abs(sp[60][1] + 50) < 0.5, "should settle: " + sp[60]);
assert(Math.max(...sp.map(p => p[0])) < 105, "overshoots too much");
// Accurate mode (no spring) is just the latest raw position.
assert.deepStrictEqual(mousePath(moves, 30, 20, null)[15], [100, -50]);

// Timeline: a trim at the start, a cut, then a 2× speed-up (source seconds → output seconds).
const tl = timeline([
    { sourceStartMs: 1000, sourceEndMs: 5000, timeScale: 1 },
    { sourceStartMs: 8000, sourceEndMs: 10000, timeScale: 2 }
], 12);
const near = (a, b) => Math.abs(a - b) < 1e-9;
assert(near(tl.duration, 4 + 1), "duration " + tl.duration);
assert(near(tl.src(0), 1) && near(tl.src(3.5), 4.5), "src in first slice");
assert(near(tl.src(4.5), 9), "src in sped-up slice: " + tl.src(4.5));
assert(near(tl.out(9), 4.5) && near(tl.out(2), 1), "out");
assert(near(tl.out(6), 4) && tl.isCut(6) && tl.isCut(0.5) && !tl.isCut(9), "cuts snap to the next slice");
assert(tl.at(4.5).ts === 2 && tl.at(99).ts === 2, "slice lookup");
assert(near(timeline([], 7).duration, 7), "no slices = whole recording");

// Spring settle: Screen Studio's default zoom springs settle in roughly half a second to a second.
const settle = springSettle({ stiffness: 200, damping: 40, mass: 2.25 });
assert(settle > 0.3 && settle < 0.8, "settle " + settle);
assert(springSettle({ stiffness: 170, damping: 50, mass: 3 }) > settle, "heavier, more damped spring is slower");

console.log("ok", kept, k2.length + "/" + noisy.length, "spring@0.53s", sp[16][0].toFixed(1));
