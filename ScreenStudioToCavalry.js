// Screen Studio → Cavalry
// Port of https://github.com/aedev-tools/screen-studio-to-after-effects (MIT)
// Copy into your Cavalry Scripts folder and run it from the Scripts menu: it asks for a .screenstudio project and builds the comp.

// Screen Studio picks the frame rate at export time, so it isn't in the project file.
var FPS = 30;
// Keyframe simplification: max error allowed by the linear curve between kept keys.
// Raise these for fewer keys, lower them for more accuracy.
var TIME_TOLERANCE = 1;    // comp frames the shown video frame may be off by
var CURSOR_TOLERANCE = 3;  // screen points the cursor may be off by

function readJSON(path) {
    if (!api.filePathExists(path)) return null;
    var j = JSON.parse(api.readFromFile(path));
    return j.json || j;
}

function load(path) {
    return path && api.filePathExists(path) ? api.loadAsset(path, false) : null;
}

// Rectangle filled with an asset via an Image Shader.
function footageRect(name, asset, w, h, radius) {
    var id = api.primitive("rectangle", name);
    // Transparent base fill so PNG alpha (cursor) doesn't show the default grey
    api.set(id, { "generator.dimensions": [w, h], "generator.cornerRadius": radius || 0, "material.materialColor": "#00000000" });
    var sh = api.create("imageShader", name + " Shader");
    // Fit Cover. Use Footage FPS off so the shader's Time is a plain frame index (see retime()).
    api.set(sh, { scaleMode: 4, useFootageFps: false });
    api.connect(asset, "id", sh, "image");
    api.connect(sh, "id", id, "material.colorShaders");
    api.parent(sh, id);
    return id;
}

function shaderOf(rect) {
    return api.getChildren(rect).filter(function (c) { return api.getLayerType(c) === "imageShader"; })[0];
}

// Slices cut and speed up/slow down the recording. Zoom ranges, mouse and click data all use
// recording (source) time, so everything goes through this map. Times in seconds.
function timeline(slices, recordingEnd) {
    if (!slices || !slices.length) slices = [{ sourceStartMs: 0, sourceEndMs: recordingEnd * 1000, timeScale: 1 }];
    var list = [], o = 0;
    slices.forEach(function (s) {
        var s0 = s.sourceStartMs / 1000, s1 = s.sourceEndMs / 1000, ts = s.timeScale || 1;
        list.push({ s0: s0, s1: s1, ts: ts, o0: o, o1: o + (s1 - s0) / ts, hideCursor: !!s.hideCursor });
        o += (s1 - s0) / ts;
    });
    var last = list[list.length - 1];
    return {
        duration: o,
        // slice playing at output time u
        at: function (u) {
            for (var i = 0; i < list.length; i++) if (u < list[i].o1) return list[i];
            return last;
        },
        // output time → source time
        src: function (u) {
            var s = this.at(u);
            return Math.min(s.s1, s.s0 + Math.max(0, u - s.o0) * s.ts);
        },
        // source time → output time; times inside a cut snap to where the cut lands
        out: function (t) {
            for (var i = 0; i < list.length; i++) {
                if (t < list[i].s0) return list[i].o0;
                if (t <= list[i].s1) return list[i].o0 + (t - list[i].s0) / list[i].ts;
            }
            return o;
        },
        isCut: function (t) {
            return !list.some(function (s) { return t >= s.s0 && t <= s.s1; });
        }
    };
}

// Douglas–Peucker over time: from per-frame samples [{f, v: [..]}], keep only the frames needed so
// linear interpolation between them stays within tol. err(sample, predictedValue, component) defaults
// to the absolute difference. Returns the kept samples.
function simplify(samples, tol, err) {
    err = err || function (s, p, c) { return Math.abs(s.v[c] - p); };
    var n = samples.length, keep = [];
    if (n < 3) return samples.slice();
    keep[0] = keep[n - 1] = true;
    var stack = [[0, n - 1]];
    while (stack.length) {
        var seg = stack.pop(), a = samples[seg[0]], b = samples[seg[1]], worst = -1, worstErr = tol;
        for (var i = seg[0] + 1; i < seg[1]; i++) {
            var u = (samples[i].f - a.f) / (b.f - a.f);
            for (var c = 0; c < a.v.length; c++) {
                var e = err(samples[i], a.v[c] + (b.v[c] - a.v[c]) * u, c);
                if (e > worstErr) { worstErr = e; worst = i; }
            }
        }
        if (worst < 0) continue;
        keep[worst] = true;
        stack.push([seg[0], worst], [worst, seg[1]]);
    }
    return samples.filter(function (s, i) { return keep[i]; });
}

// Keyframe simplified samples (api.keyframe keys interpolate linearly by default); a value that
// never changes is set statically instead. attrs[c] names the attribute for v[c].
function keyLinear(layer, samples, attrs, tol, err) {
    var moving = attrs.map(function (a, c) {
        var still = samples.every(function (s) { return s.v[c] === samples[0].v[c]; });
        if (still) { var d = {}; d[a] = samples[0].v[c]; api.set(layer, d); }
        return !still;
    });
    if (moving.indexOf(true) < 0) return;
    simplify(samples, tol, err).forEach(function (s) {
        var d = {};
        attrs.forEach(function (a, c) { if (moving[c]) d[a] = s.v[c]; });
        api.keyframe(layer, s.f, d);
    });
}

// Plain bezier ease (no magic easing): flat handles, each side `influence` of its segment long,
// like AE's keyframe influence. Handle weight is in frames.
function easeKeys(layer, attr, frames, influence) {
    frames.forEach(function (f, i) {
        if (i > 0) api.modifyKeyframeTangent(layer, { [attr]: { frame: f, inHandle: true, angle: 0, weight: (f - frames[i - 1]) * influence, angleLocked: true, weightLocked: false } });
        if (i < frames.length - 1) api.modifyKeyframeTangent(layer, { [attr]: { frame: f, outHandle: true, angle: 0, weight: (frames[i + 1] - f) * influence, angleLocked: true, weightLocked: false } });
    });
}

// Seconds for a spring to settle within 2% of a step. Gives zooms the length Screen Studio's
// screenMovementSpring would.
function springSettle(sp) {
    var x = 0, v = 0, h = 1 / 240, last = 0;
    for (var t = h; t < 5; t += h) {
        v += (sp.stiffness * (1 - x) - sp.damping * v) / sp.mass * h;
        x += v * h;
        if (Math.abs(1 - x) > 0.02) last = t;
    }
    return last;
}

// Screen Studio records variable frame rate: frames only land when the screen changes, while the
// header claims 120fps. Cavalry plays frames by index at a fixed rate, so the video drifts seconds
// away from the (real-time) mouse data. Read each frame's real timestamp with ffprobe...
function videoFrameTimes(path) {
    var r = api.runProcess("sh", ["-c",
        'PATH="/opt/homebrew/bin:/usr/local/bin:$PATH" ffprobe -v error -select_streams v:0 -show_entries packet=pts_time -of csv=p=0 "$1"',
        "_", path]);
    if (!r || r.error || !r.output) return null;
    var times = r.output.split("\n").map(parseFloat).filter(function (t) { return !isNaN(t); });
    return times.length ? times.sort(function (a, b) { return a - b; }) : null;
}

// ...then keyframe the shader's Time so each comp frame shows the video frame recorded at that
// moment (after slices). tl: timeline().
function retime(shader, times, fps, endFrame, tl) {
    api.disconnect(api.getActiveComp(), "time", shader, "time");
    var samples = [];
    for (var f = 0; f <= endFrame; f++) {
        var t = tl.src(f / fps), k = 0, lo = 0, hi = times.length - 1;
        while (lo <= hi) { var mid = (lo + hi) >> 1; if (times[mid] <= t + 1e-6) { k = mid; lo = mid + 1; } else hi = mid - 1; }
        samples.push({ f: f, v: [k], ts: tl.at(f / fps).ts });
    }
    // Measure error in output seconds, not frame numbers: after a pause the next video frame can be a
    // second later, so being "1 frame off" there would show a change early. Check both neighbours of a
    // fractional Time since we don't rely on how Cavalry rounds it.
    var at = function (i) { return times[Math.max(0, Math.min(times.length - 1, i))]; };
    keyLinear(shader, samples, ["time"], TIME_TOLERANCE / fps, function (s, p) {
        return Math.max(Math.abs(at(Math.floor(p)) - at(s.v[0])), Math.abs(at(Math.ceil(p)) - at(s.v[0]))) / s.ts;
    });
}

// Screen Studio's cursor smoothing: a damped spring chasing the raw mouse position.
// moves: [{t (source s), x, y}] sorted by time. spring: {stiffness, damping, mass} or null for raw
// ("accurate"). src maps output → source time (identity if omitted). Returns [x, y] per comp frame.
function mousePath(moves, fps, endFrame, spring, src) {
    src = src || function (u) { return u; };
    var out = [], m = 0, x = moves[0].x, y = moves[0].y, vx = 0, vy = 0;
    var sub = 8, h = 1 / fps / sub; // 240Hz steps at 30fps keeps the integration stable
    for (var f = 0; f <= endFrame; f++) {
        for (var s = 0; s < sub; s++) {
            var t = src((f + s / sub) / fps);
            while (m + 1 < moves.length && moves[m + 1].t <= t) m++;
            if (!spring) { x = moves[m].x; y = moves[m].y; break; }
            vx += (spring.stiffness * (moves[m].x - x) - spring.damping * vx) / spring.mass * h;
            vy += (spring.stiffness * (moves[m].y - y) - spring.damping * vy) / spring.mass * h;
            x += vx * h; y += vy * h;
        }
        out.push([x, y]);
    }
    return out;
}

function dropShadow(layer, alpha, angle, dist, blur) {
    var f = api.create("dropShadowFilter", "Drop Shadow");
    var a = angle * Math.PI / 180;
    api.set(f, {
        amount: [blur, blur],
        offset: [dist * Math.cos(a), -dist * Math.sin(a)], // Screen Studio 90° = down, Cavalry +Y is up
        shadowColor: { r: 0, g: 0, b: 0, a: Math.round(alpha * 100) }
    });
    api.connect(f, "id", layer, "filters");
    api.parent(f, layer);
}

function importScreenStudio(base) {
    var rec = base + "/recording";
    var proj = readJSON(base + "/project.json");
    var meta = readJSON(rec + "/metadata.json");
    if (!proj || !meta) throw new Error("Not a Screen Studio project (missing project.json / recording/metadata.json)");
    var config = proj.config || {};
    var scene = (proj.scenes || [])[0] || {};
    var warnings = [];

    var recs = {};
    (meta.recorders || meta.channels || []).forEach(function (r) { if (!recs[r.type]) recs[r.type] = r; });
    if (!recs.display) throw new Error("No display recording in metadata");
    var dSess = (recs.display.sessions || [])[0] || {};
    var bounds = dSess.bounds || recs.display.bounds;
    var sess = (meta.sessions || [])[0] || dSess;
    var t0 = sess.processTimeStartMs;
    var tl = timeline(scene.slices, (sess.processTimeEndMs - t0) / 1000);

    function mediaPath(r) {
        var s = r && (r.sessions || [])[0];
        return s && s.outputFilename ? rec + "/" + s.outputFilename : null;
    }
    var micPath = null;
    if (recs.microphone && api.filePathExists(rec + "/enhanced")) {
        api.listDirectory(rec + "/enhanced").forEach(function (p) {
            if (/microphone/.test(p) && /enhanced/.test(api.getFileNameFromPath(p, true))) micPath = p;
        });
    }
    micPath = micPath || mediaPath(recs.microphone);

    // --- Comp: the recording's native resolution, or Screen Studio's output aspect ratio if one is set ---
    // Work in Screen Studio points (bounds space) — mouse data is in points and the video
    // resolution isn't readable until Cavalry finishes loading the asset.
    var W = bounds.width, H = bounds.height;
    var COMP_H = Math.round(H / (dSess.recordingScale || 0.5)), COMP_W = Math.round(W / (dSess.recordingScale || 0.5));
    var ar = String(config.defaultOutputAspectRatio || "").match(/(\d+(?:\.\d+)?)\s*[:x\/]\s*(\d+(?:\.\d+)?)/);
    if (ar) COMP_W = Math.round(COMP_H * ar[1] / ar[2]); // ponytail: guessed "16:9" format, no sample project sets it
    COMP_W += COMP_W % 2; COMP_H += COMP_H % 2;       // even sizes for video export
    var comp = api.createComp("SS - " + proj.name);
    api.setActiveComp(comp);
    var endFrame = Math.ceil(tl.duration * FPS);
    api.set(comp, { resolution: [COMP_W, COMP_H], fps: FPS, startFrame: 0, endFrame: endFrame, playbackStart: 0, playbackEnd: endFrame, backgroundColor: "#000000" });
    var frame = function (t) { return Math.round(t * FPS); };
    var toLocal = function (x, y) {
        return [Math.max(-W / 2, Math.min(W / 2, x - bounds.x - W / 2)),
                Math.max(-H / 2, Math.min(H / 2, -(y - bounds.y - H / 2)))];
    };

    // --- Background: colour, gradient, or your own image. Screen Studio's bundled wallpapers are its own artwork, so we don't copy them ---
    var bg = api.primitive("rectangle", "Background");
    api.set(bg, { "generator.dimensions": [COMP_W, COMP_H], "material.materialColor": config.backgroundColor || "#000000" });
    var type = config.backgroundType;
    var img = config.backgroundImage;
    var imgPath = img && (typeof img === "string" ? img : img.path || img.filePath || img.fileName); // ponytail: format guessed, no sample project uses an image background
    if (imgPath && imgPath.charAt(0) !== "/") imgPath = base + "/" + imgPath;
    var imgAsset = type === "image" && load(imgPath);
    if (imgAsset) {
        var bgs = api.create("imageShader", "Background Image");
        api.set(bgs, { scaleMode: 4 });
        api.connect(imgAsset, "id", bgs, "image");
        api.connect(bgs, "id", bg, "material.colorShaders");
        api.parent(bgs, bg);
    } else if (type !== "color") {
        if (type === "system") warnings.push("Screen Studio's built-in wallpaper (" + config.backgroundSystemName + ") isn't copied. The background uses the project's gradient instead: swap in your own image if you like.");
        else if (type === "image") warnings.push("Couldn't find the background image" + (imgPath ? " at " + imgPath : "") + ". The background uses the project's gradient instead.");
        var grad = config.backgroundGradient || {};
        var stops = (grad.stops || []).map(function (s) { return s.color; });
        if (stops.length >= 2) {
            var gs = api.create("gradientShader", "Background Gradient");
            api.setGradientFromColors(gs, "generator.gradient", stops);
            var gStart = grad.start || { x: 0, y: 0 }, gEnd = grad.end || { x: 1, y: 1 };
            api.set(gs, { "generator.rotation": Math.atan2(-(gEnd.y - gStart.y) * COMP_H, (gEnd.x - gStart.x) * COMP_W) * 180 / Math.PI });
            api.connect(gs, "id", bg, "material.colorShaders");
            api.parent(gs, bg);
        }
    }
    if (imgAsset && config.backgroundBlur) {
        var blur = api.create("blurFilter", "Background Blur");
        var b = config.backgroundBlur * COMP_H / 1080; // ponytail: Screen Studio's blur unit is a guess (px at 1080p)
        api.set(blur, { amount: [b, b], tileMode: 0 }); // Clamp: no see-through edges
        api.connect(blur, "id", bg, "filters");
        api.parent(blur, bg);
    }

    // --- Screen ---
    var syncVideo = function (rect, path) {
        var times = api.runProcess && videoFrameTimes(path);
        if (times) retime(shaderOf(rect), times, FPS, endFrame, tl);
        else warnings.push("Couldn't run ffprobe (brew install ffmpeg), so " + api.getFileNameFromPath(path, true) + " will drift out of sync with the cursor" + (scene.slices && scene.slices.length > 1 ? " and ignore trims/speed changes." : "."));
    };

    var displayAsset = load(mediaPath(recs.display));
    if (!displayAsset) throw new Error("Display recording not found");
    // Group holds the zoom/pan; the screen and cursor sit inside it untouched
    var group = api.create("group", "Screen Recording");
    var screen = footageRect("Screen", displayAsset, W, H, config.windowBorderRadius != null ? config.windowBorderRadius : 12);
    api.parent(screen, group);
    syncVideo(screen, mediaPath(recs.display));
    dropShadow(screen, config.shadowIntensity != null ? config.shadowIntensity : 0.5,
        config.shadowAngle != null ? config.shadowAngle : 90, config.shadowDistance || 10, config.shadowBlur || 20);

    var pad = (config.backgroundPaddingRatio != null ? config.backgroundPaddingRatio : 10) / 100;
    var baseScale = Math.min(COMP_W * (1 - 2 * pad) / W, COMP_H * (1 - 2 * pad) / H);
    api.set(group, { scale: [baseScale, baseScale], position: [0, 0] });

    // --- Clicks (in output time; clicks inside cut sections are dropped) ---
    var clicks = (readJSON(rec + "/mouseclicks-0.json") || []).filter(function (c) {
        return (c.type === "mouseDown" || c.type === "down") && !tl.isCut((c.processTimeMs - t0) / 1000);
    }).map(function (c) {
        return { t: tl.out((c.processTimeMs - t0) / 1000), p: toLocal(c.x, c.y) };
    });

    // --- Zoom (all ranges; AE version only did the first). Length comes from Screen Studio's zoom spring ---
    var zoomDur = springSettle(config.screenMovementSpring || { stiffness: 170, damping: 50, mass: 3 });
    // keys[frame] = {s: scale, p: [x,y]}. Screen position that centres local point p at zoom s, clamped to comp edges.
    var keys = {};
    var aim = function (p, s) {
        var lx = Math.max(0, (W * s - COMP_W) / 2), ly = Math.max(0, (H * s - COMP_H) / 2);
        return [Math.max(-lx, Math.min(lx, -p[0] * s)), Math.max(-ly, Math.min(ly, -p[1] * s))];
    };
    var ranges = (scene.zoomRanges || []).filter(function (z) { return !z.isDisabled; }).map(function (z) {
        return { st: tl.out(z.startTime / 1000), en: tl.out(z.endTime / 1000), z: z };
    }).filter(function (r) { return r.en > r.st; }) // entirely inside a cut
      .sort(function (a, b) { return a.st - b.st; });
    ranges.forEach(function (r, i) {
        var z = r.z, st = r.st, en = r.en, zs = baseScale * z.zoom;
        var dur = z.hasInstantAnimation ? 1 / FPS : Math.min(zoomDur, (en - st) / 2);
        var prev = ranges[i - 1], next = ranges[i + 1];
        var chainedIn = prev && st - prev.en < zoomDur;   // glide straight from previous zoom
        var chainedOut = next && next.st - en < zoomDur;
        var targets = z.type === "manual"
            ? [{ t: st, p: [(z.manualTargetPoint.x - 0.5) * W, (0.5 - z.manualTargetPoint.y) * H] }]
            : clicks.filter(function (c) { return c.t >= st && c.t <= en; });
        if (!targets.length) targets = [{ t: st, p: [0, 0] }];

        if (!chainedIn) keys[frame(st)] = { s: baseScale, p: [0, 0] };
        keys[frame(st + dur)] = { s: zs, p: aim(targets[0].p, zs) };
        var last = st + dur;
        targets.slice(1).forEach(function (c) {
            if (c.t - last < 1 || c.t > en) return; // ponytail: 1s debounce keeps the pan calm; lower it to follow every click
            keys[frame(c.t)] = { s: zs, p: aim(c.p, zs) };
            last = c.t;
        });
        if (!chainedOut) {
            keys[frame(en)] = { s: zs, p: aim(targets[targets.length - 1].p, zs) };
            keys[frame(Math.min(en + dur, tl.duration))] = { s: baseScale, p: [0, 0] };
        }
    });
    var zoomFrames = Object.keys(keys).map(Number).sort(function (a, b) { return a - b; });
    zoomFrames.forEach(function (f) {
        var k = keys[f];
        api.keyframe(group, f, { "scale.x": k.s, "scale.y": k.s, "position.x": k.p[0], "position.y": k.p[1] });
    });
    // Same ease strengths as the AE version: 75% on scale, 66% on position
    easeKeys(group, "scale.x", zoomFrames, 0.75);
    easeKeys(group, "scale.y", zoomFrames, 0.75);
    easeKeys(group, "position.x", zoomFrames, 0.66);
    easeKeys(group, "position.y", zoomFrames, 0.66);

    // --- Cursor: a group that follows the mouse (inside the screen group, so it inherits zoom/pan),
    // with one image per cursor type swapped by opacity ---
    var moves = (readJSON(rec + "/mousemoves-0.json") || []).map(function (mv) {
        return { t: (mv.processTimeMs - t0) / 1000, x: mv.x, y: mv.y, id: mv.cursorId || "arrow" };
    });
    if (!config.hideCursor && moves.length) {
        var info = {};
        var cursors = readJSON(rec + "/cursors.json") || [];
        (cursors instanceof Array ? cursors : Object.keys(cursors).map(function (k) { cursors[k].id = k; return cursors[k]; }))
            .forEach(function (c) { info[c.id] = c; });
        var png = function (id) { return rec + "/cursors/" + id + ".png"; };
        var types = {}; // cursor id → id to use (arrow if there's no image for it)
        var typeOf = function (id) {
            if (!(id in types)) types[id] = api.filePathExists(png(id)) ? id : "arrow";
            return types[id];
        };

        // Which cursor shows at each frame (null = hidden: slice hides it, or idle past Screen Studio's timeout)
        var idle = config.hideNotMovingCursorAfterMs != null ? config.hideNotMovingCursorAfterMs / 1000 : Infinity;
        var shown = [], m = 0;
        for (var f = 0; f <= endFrame; f++) {
            var u = f / FPS, t = tl.src(u);
            while (m + 1 < moves.length && moves[m + 1].t <= t) m++;
            shown.push(tl.at(u).hideCursor || t - moves[m].t > idle ? null : typeOf(moves[m].id));
        }

        var cursor = api.create("group", "Cursor");
        api.parent(cursor, group);
        var spring = config.disableMouseMovementSpring ? null : (config.mouseMovementSpring || { stiffness: 470, damping: 70, mass: 3 });
        var path = mousePath(moves, FPS, endFrame, spring, function (u) { return tl.src(u); });
        keyLinear(cursor, path.map(function (q, f) { return { f: f, v: toLocal(q[0], q[1]) }; }), ["position.x", "position.y"], CURSOR_TOLERANCE);

        var cs = config.cursorSize || 1;
        var used = {};
        shown.forEach(function (id) { if (id) used[id] = true; });
        Object.keys(used).forEach(function (id) {
            var ci = info[id] || {}, size = ci.standardSize || { width: 17, height: 23 }, hot = ci.hotSpot || { x: 4, y: 4 };
            var cw = size.width * cs, ch = size.height * cs;
            var img = footageRect(id, load(png(id)), cw, ch, 0);
            api.parent(img, cursor);
            // Offset so the hotspot (not the centre) sits on the mouse position
            api.set(img, { position: [cw / 2 - hot.x * cs, -(ch / 2 - hot.y * cs)] });
            keyLinear(img, shown.map(function (s, f) { return { f: f, v: [s === id ? 100 : 0] }; }), ["opacity"], 0);
        });
    }

    // --- Webcam ---
    var camAsset = !config.hideCamera && load(mediaPath(recs.webcam));
    if (camAsset) {
        // ponytail: webcam resolution isn't readable at import time, assume 16:9 (Fit Cover, so no stretching)
        var camW = COMP_W * (config.cameraSize || 0.25);
        var camH = config.cameraAspectRatio === "square" ? camW : camW * 9 / 16;
        var cam = footageRect("Webcam", camAsset, camW, camH, Math.min(camW, camH) * (config.cameraRoundness != null ? config.cameraRoundness : 0.25) / 2);
        var cpp = config.cameraPositionPoint || { x: 1, y: 1 }, wcPad = 40 * COMP_H / 1080;
        api.set(cam, { position: [
            wcPad + camW / 2 + cpp.x * (COMP_W - camW - 2 * wcPad) - COMP_W / 2,
            COMP_H / 2 - (wcPad + camH / 2 + cpp.y * (COMP_H - camH - 2 * wcPad))
        ] });
        if (config.mirrorCamera) api.set(cam, { "scale.x": -1 });
        syncVideo(cam, mediaPath(recs.webcam));
        dropShadow(cam, 0.5, 135, 10, 15);
    }

    // --- Audio (Sound behaviours) ---
    var audio = 0;
    [["Microphone", micPath], ["System Audio", mediaPath(recs.systemAudio)]].forEach(function (a) {
        if (!a[1] || !api.filePathExists(a[1])) return;
        var asset = load(a[1]);
        if (!asset) { warnings.push("Cavalry couldn't load " + a[1] + " (AAC/.m4a isn't supported). Convert it to .wav and add a Sound behaviour."); return; }
        var snd = api.create("sound", a[0]);
        api.connect(asset, "id", snd, "file");
        audio++;
    });
    if (audio && scene.slices && scene.slices.length > 1) warnings.push("Audio plays uncut: Sound behaviours can't follow Screen Studio's trims and speed changes.");

    return { comp: comp, clicks: clicks.length, zooms: ranges.length, duration: tl.duration, warnings: warnings };
}

// Run: pick a project and import. Skipped outside Cavalry (node test.js).
if (typeof api !== "undefined") {
    var path = api.presentOpenFile(api.getProjectPath() || "", "Select a Screen Studio project", "Screen Studio (*.screenstudio)");
    if (path) {
        try {
            var r = importScreenStudio(path.replace(/\/$/, ""));
            console.info("Screen Studio import: " + r.duration.toFixed(1) + "s, " + r.zooms + " zooms, " + r.clicks + " clicks");
            if (r.warnings.length) ui.Modal.showMessage("Screen Studio Import", r.warnings.join("\n\n"));
        } catch (e) {
            ui.Modal.showMessage("Screen Studio Import", String(e));
        }
    }
}
