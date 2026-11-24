"use client";
import { useEffect, useRef, type CSSProperties } from "react";
import type { AgentState } from "@/lib/agent-state";

/**
 * A room agent's picture: a glob of light that slowly changes shape, in the agent's own colours
 * (a ramp of four, from deep to bright), with a shape of its own (seeded by its id). It moves
 * faster while the agent works and slower while it waits.
 *
 * A room can show many globs at once, more than the WebGL contexts a page may hold, so they
 * share one: each frame draws each agent's glob once on a small offscreen canvas and copies it
 * into that agent's pictures (plain 2D canvases). Globs out of view, in a hidden tab, or with
 * reduced motion are not animated; without WebGL a gradient stands in.
 */

/** Deep, middle, bright, highlight: each room colour's combination. */
export const GLOB_PALETTES: Record<string, [string, string, string, string]> = {
  violet: ["#24124f", "#6a4be6", "#c48cff", "#ffd6f2"],
  blue: ["#0a2350", "#2a74e0", "#5fd0ff", "#dcf7ff"],
  amber: ["#43150a", "#d4552a", "#f6b142", "#fff0c4"],
  green: ["#0a3324", "#239a63", "#a6e05a", "#f1ffd0"],
  rose: ["#47092a", "#d33a6e", "#ff9a86", "#ffe4d8"],
  teal: ["#062a35", "#178f96", "#5fe0c4", "#ddfff4"],
  gone: ["#1c1d22", "#4a4c55", "#8a8d98", "#cfd2da"],
  you: ["#202127", "#5b5e69", "#a4a7b2", "#eceef3"],
};

const VERTEX = `
attribute vec2 a_position;
void main() { gl_Position = vec4(a_position, 0.0, 1.0); }
`;

const FRAGMENT = `
precision mediump float;
uniform vec2 u_resolution;
uniform float u_time;
uniform float u_activity;
uniform float u_seed;
uniform vec3 u_c0;
uniform vec3 u_c1;
uniform vec3 u_c2;
uniform vec3 u_c3;

float grain(vec2 p) {
  vec3 q = fract(vec3(p.xyx) * 0.1031);
  q += dot(q, q.yzx + 19.19);
  return fract((q.x + q.y) * q.z);
}
float flowNoise(vec2 p) {
  vec2 cell = floor(p);
  vec2 f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(grain(cell), grain(cell + vec2(1.0, 0.0)), f.x), mix(grain(cell + vec2(0.0, 1.0)), grain(cell + vec2(1.0)), f.x), f.y);
}
mat2 turn(float a) {
  float c = cos(a), s = sin(a);
  return mat2(c, -s, s, c);
}
vec3 ramp(float t) {
  vec3 c = mix(u_c0, u_c1, smoothstep(0.0, 0.38, t));
  c = mix(c, u_c2, smoothstep(0.34, 0.72, t));
  return mix(c, u_c3, smoothstep(0.70, 1.0, t));
}
void main() {
  vec2 uv = (gl_FragCoord.xy * 2.0 - u_resolution) / min(u_resolution.x, u_resolution.y);
  float s = u_seed * 6.2831;
  float t = u_time + u_seed * 40.0;
  // The outline: a circle pushed about by a few slow waves and some noise, each glob its own.
  vec2 shape = turn(t * 0.11 + s) * (uv - vec2(0.03 * sin(t * 0.73 + s), 0.03 * cos(t * 0.91)));
  float angle = atan(shape.y, shape.x);
  vec2 contour = vec2(cos(angle), sin(angle));
  float wobble = flowNoise(contour * 1.6 + vec2(t * 0.21 + s, -t * 0.15)) - 0.5;
  float radius = 0.74 + 0.02 * sin(t * 1.1)
    + (0.07 + 0.02 * sin(t * 0.47)) * sin(angle * (2.0 + floor(u_seed * 2.99)) + t * 0.83 + s)
    + (0.045 + 0.02 * cos(t * 0.61)) * cos(angle * 3.0 - t * 1.07)
    + 0.02 * sin(angle * 5.0 + t * 0.69 + s * 2.0)
    + wobble * (0.08 + 0.05 * u_activity);
  float edge = length(shape) - radius;
  float pixel = 1.6 / min(u_resolution.x, u_resolution.y);
  float alpha = 1.0 - smoothstep(-pixel, pixel, edge);
  if (alpha < 0.001) { gl_FragColor = vec4(0.0); return; }
  // Inside: bands of the ramp drifting through, lit from the top left.
  vec2 field = turn(0.4 * sin(t * 0.29) + t * 0.08 + s) * uv;
  float turbulence = flowNoise(field * 2.2 + vec2(t * 0.25, -t * 0.19)) - 0.5;
  field += vec2(turbulence * (0.28 + 0.12 * u_activity), 0.14 * sin(field.x * 3.0 + t * 0.71));
  float band = 0.5 + 0.36 * sin(field.x * 2.3 + field.y * 1.7 + t * 0.6) + 0.22 * cos(field.y * 3.1 - t * 0.47) + turbulence * 0.5;
  float light = clamp(0.62 - dot(uv, vec2(0.42, -0.5)), 0.0, 1.0);
  vec3 color = ramp(clamp(band * 0.62 + light * 0.45 - 0.08, 0.0, 1.0));
  // A soft rim and a highlight give it some depth.
  color = mix(color, u_c0, smoothstep(-0.22, 0.0, edge) * 0.45);
  color += u_c3 * pow(clamp(1.0 - length(uv - vec2(-0.32, 0.36)) * 1.6, 0.0, 1.0), 3.0) * 0.35;
  color += vec3((grain(gl_FragCoord.xy) - 0.5) * 0.06);
  gl_FragColor = vec4(clamp(color, 0.0, 1.0), alpha);
}
`;

const SIZE = 96; // the shared canvas, in pixels: pictures are at most 32px at 3x
const hex = (h: string) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16) / 255) as [number, number, number];
const seedOf = (id: string) => {
  let h = 2166136261;
  for (const c of id) h = Math.imul(h ^ c.charCodeAt(0), 16777619);
  return ((h >>> 0) % 10007) / 10007;
};

type GlobState = "idle" | "working" | "waiting";
interface Target {
  ctx: CanvasRenderingContext2D;
  key: string;
  palette: [string, string, string, string];
  seed: number;
  state: GlobState;
  animated: boolean;
  visible: boolean;
}
/** Each agent's motion, shared by all its pictures so they move together. */
interface Motion {
  phase: number;
  activity: number;
}

class GlobEngine {
  private canvas = document.createElement("canvas");
  private gl: WebGLRenderingContext | null = null;
  private u: Record<string, WebGLUniformLocation | null> = {};
  private targets = new Map<HTMLCanvasElement, Target>();
  private motion = new Map<string, Motion>();
  private frame = 0;
  private last = 0;
  private reduced = matchMedia("(prefers-reduced-motion: reduce)");
  private observer = new IntersectionObserver((entries) => {
    for (const e of entries) {
      const t = this.targets.get(e.target as HTMLCanvasElement);
      if (t) t.visible = e.isIntersecting;
    }
    this.wake();
  });

  constructor() {
    this.canvas.width = this.canvas.height = SIZE;
    this.init();
    this.canvas.addEventListener("webglcontextlost", (e) => (e.preventDefault(), (this.gl = null)));
    this.canvas.addEventListener("webglcontextrestored", () => (this.init(), this.drawAll()));
    document.addEventListener("visibilitychange", () => this.wake());
    this.reduced.addEventListener("change", () => (this.drawAll(), this.wake()));
  }

  get works() {
    return this.gl !== null;
  }

  private init() {
    const gl = this.canvas.getContext("webgl", { alpha: true, antialias: true, premultipliedAlpha: false, preserveDrawingBuffer: true, powerPreference: "low-power" });
    if (!gl) return;
    const program = gl.createProgram()!;
    for (const [type, src] of [
      [gl.VERTEX_SHADER, VERTEX],
      [gl.FRAGMENT_SHADER, FRAGMENT],
    ] as const) {
      const sh = gl.createShader(type)!;
      gl.shaderSource(sh, src);
      gl.compileShader(sh);
      if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) return;
      gl.attachShader(program, sh);
    }
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) return;
    gl.useProgram(program);
    gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    const pos = gl.getAttribLocation(program, "a_position");
    gl.enableVertexAttribArray(pos);
    gl.vertexAttribPointer(pos, 2, gl.FLOAT, false, 0, 0);
    for (const n of ["u_resolution", "u_time", "u_activity", "u_seed", "u_c0", "u_c1", "u_c2", "u_c3"]) this.u[n] = gl.getUniformLocation(program, n);
    gl.viewport(0, 0, SIZE, SIZE);
    gl.uniform2f(this.u.u_resolution!, SIZE, SIZE);
    this.gl = gl;
  }

  add(el: HTMLCanvasElement, t: Omit<Target, "ctx" | "visible">) {
    const ctx = el.getContext("2d");
    if (!ctx) return;
    this.targets.set(el, { ...t, ctx, visible: true });
    if (!this.motion.has(t.key)) this.motion.set(t.key, { phase: 0, activity: t.state === "working" ? 1 : 0 });
    this.observer.observe(el);
    this.drawKey(t.key);
    this.wake();
  }

  update(el: HTMLCanvasElement, t: Partial<Omit<Target, "ctx" | "visible">>) {
    const cur = this.targets.get(el);
    if (!cur) return;
    Object.assign(cur, t);
    this.drawKey(cur.key);
    this.wake();
  }

  remove(el: HTMLCanvasElement) {
    this.observer.unobserve(el);
    const key = this.targets.get(el)?.key;
    this.targets.delete(el);
    if (key && ![...this.targets.values()].some((t) => t.key === key)) this.motion.delete(key);
  }

  /** Draw one agent's glob and copy it into each of its pictures. */
  private drawKey(key: string, only?: (t: Target) => boolean) {
    const gl = this.gl;
    const mine = [...this.targets.values()].filter((t) => t.key === key && (!only || only(t)));
    if (!gl || !mine.length) return;
    const { palette, seed } = mine[0]!;
    const m = this.motion.get(key) ?? { phase: 0, activity: 0 };
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.uniform1f(this.u.u_time!, m.phase);
    gl.uniform1f(this.u.u_activity!, m.activity);
    gl.uniform1f(this.u.u_seed!, seed);
    palette.forEach((c, i) => gl.uniform3f(this.u[`u_c${i}`]!, ...hex(c)));
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    for (const t of mine) {
      const c = t.ctx.canvas;
      t.ctx.clearRect(0, 0, c.width, c.height);
      t.ctx.drawImage(this.canvas, 0, 0, c.width, c.height);
    }
  }

  private drawAll() {
    for (const key of new Set([...this.targets.values()].map((t) => t.key))) this.drawKey(key);
  }

  private live = () => [...this.targets.values()].filter((t) => t.animated && t.visible);

  private wake() {
    if (this.frame || document.hidden || this.reduced.matches || !this.gl || !this.live().length) return;
    this.last = 0;
    this.frame = requestAnimationFrame(this.tick);
  }

  private tick = (now: number) => {
    this.frame = 0;
    const live = this.live();
    if (document.hidden || this.reduced.matches || !this.gl || !live.length) return;
    if (!this.last || now - this.last >= 1000 / 30) {
      const dt = this.last ? Math.min((now - this.last) / 1000, 0.1) : 0;
      this.last = now;
      for (const key of new Set(live.map((t) => t.key))) {
        const states = live.filter((t) => t.key === key).map((t) => t.state);
        const state: GlobState = states.includes("working") ? "working" : states.includes("waiting") ? "waiting" : "idle";
        const m = this.motion.get(key)!;
        m.activity += ((state === "working" ? 1 : state === "waiting" ? 0.2 : 0) - m.activity) * Math.min(dt * 1.5, 1);
        m.phase += dt * (state === "waiting" ? 0.45 : 0.55 + m.activity * 1.4);
        this.drawKey(key, (t) => t.animated && t.visible);
      }
    }
    this.frame = requestAnimationFrame(this.tick);
  };
}

let engine: GlobEngine | null = null;
const getEngine = () => (engine ??= new GlobEngine());

/** An agent state (lib/agent-state) as how a glob moves. */
export const globState = (s: AgentState | undefined): GlobState => (s === "working" ? "working" : s === "needs-you" || s === "queued" ? "waiting" : "idle");

export function AgentGlob({ id, color, size = 22, state = "idle", animated = true, label }: { id: string; color: string | undefined; size?: number; state?: GlobState; animated?: boolean; label?: string }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const palette = GLOB_PALETTES[color ?? "gone"] ?? GLOB_PALETTES.gone!;
  const key = `${color}:${id}`;
  const seed = seedOf(id);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const px = Math.round(size * Math.min(devicePixelRatio || 1, 3));
    el.width = el.height = px;
    const e = getEngine();
    e.add(el, { key, palette, seed, state, animated });
    el.parentElement?.classList.toggle("is-fallback", !e.works);
    return () => e.remove(el);
    // Size, palette and seed follow from the key; state and animated update in place below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, size]);
  useEffect(() => {
    if (ref.current) getEngine().update(ref.current, { state, animated });
  }, [state, animated]);

  const [c0, c1, c2] = palette;
  return (
    <span
      className="agent-glob"
      role={label ? "img" : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
      style={{ "--glob-size": `${size}px`, "--glob-fallback": `radial-gradient(circle at 34% 30%, ${c2}, ${c1} 55%, ${c0})` } as CSSProperties}
    >
      <canvas ref={ref} />
    </span>
  );
}
