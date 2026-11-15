# Roadmap

## Phase 1: proof of concept (this version)
- [x] FTMS connection, live data, automatic resistance control
- [x] Circuit library, workout engine, simulator
- [ ] **Validate on the real ProForm** (run *Quick Sync Test*, check the connection log)
- [ ] Custom circuit builder (saved locally)
- [ ] Workout history / summary screen

## Phase 2: 3D virtual world with a follow camera

The 3D world will be **another listener** on the same data the dashboard uses. The engine and Bluetooth
code stay unchanged. `main.js` already publishes everything on `window.ellipticalBus`:

| Event | Detail | 3D use |
|---|---|---|
| `telemetry` | `speedKmh`, `cadence`, `powerW`, `resistance`, `heartRate` | character speed and stride animation rate |
| `workout` | `segment` (`kind`, `pct`, `label`), `level`, `state` | terrain slope, scenery, on-screen cues |

Proposed stack: **Three.js** (loaded as an ES module, so still no build step).

1. **Route**: a spline path (`CatmullRomCurve3`) generated from the circuit. Each segment becomes a stretch of road.
   Its slope comes from `pct` (climbs for `work`, flats or descents for `recover`), so the world *looks* like what the legs *feel*.
2. **Character**: a rigged glTF model with walk/run clips. `AnimationMixer` blends between them by speed, and the clip
   `timeScale` follows cadence so the strides match the rider's.
3. **Movement**: distance along the spline += speed × dt. The character is placed at `curve.getPointAt(u)` and faces the tangent.
4. **Follow camera**: a third-person camera eased behind and above the character (`lerp` position, `lookAt` slightly ahead),
   with a gentle bob tied to stride frequency.
5. **HUD**: the current dashboard (countdown, level, profile with playhead) shrinks to an overlay on top of the 3D canvas.
6. **Performance**: target 60 fps on a mid-range tablet. Use instanced scenery, baked lighting and low-poly terrain chunks
   streamed along the route.

Later ideas: ghost rider of your previous best, multiple worlds (coast, forest, mountain), heart-rate-driven weather/time of day.
