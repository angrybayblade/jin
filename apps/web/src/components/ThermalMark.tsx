"use client";
import { AGENT_LABEL, type AgentState } from "@/lib/agent-state";
// Zero's WebGL thermal-metal mark, used by jin for its logo, loading and status
// indicators. Ported from ComposioHQ/zero (src/components/ZeroMark.tsx): same shader,
// silhouettes, frame budget, reduced-motion, context-loss and SVG fallback handling.
import { useEffect, useId, useRef, useState, type CSSProperties } from "react";

export type MarkVariant = "blob" | "connection" | "workflow" | "command" | "file";
const markVariants: MarkVariant[] = ["blob", "connection", "workflow", "command", "file"];
const markPaths: Record<MarkVariant, string> = {
  blob: "M51 9C68 8 81 18 85 34S91 63 79 78S46 95 29 83S12 61 14 44S31 11 51 9Z",
  connection: "M24 20C8 20 8 80 24 80C40 80 60 20 76 20C92 20 92 80 76 80C60 80 40 20 24 20Z",
  workflow: "M50 10A40 40 0 1 1 49.9 10ZM50 30A20 20 0 1 0 50.1 30Z",
  command: "M50 8L92 50L50 92L8 50Z",
  file: "M22 12H65L82 30V88H22Z",
};

export type MarkState = "idle" | "working" | "waiting" | "user" | "queued";

const vertexSource = `
attribute vec2 a_position;
void main() { gl_Position = vec4(a_position, 0.0, 1.0); }
`;

const fragmentSource = `
#ifdef GL_FRAGMENT_PRECISION_HIGH
precision highp float;
#else
precision mediump float;
#endif
uniform vec2 u_resolution;
uniform float u_time;
uniform float u_activity;
uniform float u_variant;

float grain(vec2 p) {
  vec3 q = fract(vec3(p.xyx) * 0.1031);
  q += dot(q, q.yzx + 19.19);
  return fract((q.x + q.y) * q.z);
}
float flowNoise(vec2 p) {
  vec2 cell = floor(p);
  vec2 f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(grain(cell), grain(cell + vec2(1.0, 0.0)), f.x),
             mix(grain(cell + vec2(0.0, 1.0)), grain(cell + vec2(1.0)), f.x), f.y);
}
mat2 turn(float angle) {
  float c = cos(angle), s = sin(angle);
  return mat2(c, -s, s, c);
}
vec3 thermalMetal(float t) {
  vec3 color = vec3(0.77, 0.78, 0.82);
  color = mix(color, vec3(0.71, 0.72, 0.80), smoothstep(0.08, 0.18, t));
  color = mix(color, vec3(0.44, 0.18, 0.20), smoothstep(0.19, 0.27, t));
  color = mix(color, vec3(0.73, 0.27, 0.19), smoothstep(0.28, 0.36, t));
  color = mix(color, vec3(0.91, 0.58, 0.18), smoothstep(0.37, 0.45, t));
  color = mix(color, vec3(0.94, 0.76, 0.43), smoothstep(0.46, 0.51, t));
  color = mix(color, vec3(0.93, 0.67, 0.25), smoothstep(0.52, 0.58, t));
  color = mix(color, vec3(0.78, 0.31, 0.19), smoothstep(0.59, 0.67, t));
  color = mix(color, vec3(0.48, 0.21, 0.24), smoothstep(0.68, 0.75, t));
  color = mix(color, vec3(0.73, 0.77, 0.84), smoothstep(0.76, 0.81, t));
  color = mix(color, vec3(0.65, 0.67, 0.75), smoothstep(0.82, 0.86, t));
  return mix(color, vec3(0.35, 0.19, 0.22), smoothstep(0.87, 0.99, t));
}
void main() {
  vec2 uv = (gl_FragCoord.xy * 2.0 - u_resolution) / min(u_resolution.x, u_resolution.y);
  float t = u_time;
  vec2 orbit = vec2(0.035 * sin(t * 0.73), 0.03 * cos(t * 0.91));
  float twist = t * 0.12 + 0.24 * sin(t * 0.37);
  vec2 shape = turn(twist) * (uv - orbit);
  shape /= vec2(0.95 + 0.035 * sin(t * 0.81), 0.95 + 0.035 * cos(t * 0.67));
  float angle = atan(shape.y, shape.x);
  vec2 contour = vec2(cos(angle), sin(angle));
  float irregularity = flowNoise(contour * 1.7 + vec2(t * 0.19, -t * 0.13)) - 0.5;
  float radius = 0.70 + 0.018 * sin(t * 1.13)
    + (0.080 + 0.025 * sin(t * 0.47)) * sin(angle * 3.0 + t * 0.83)
    + (0.050 + 0.020 * cos(t * 0.61)) * cos(angle * 2.0 - t * 1.07)
    + 0.024 * sin(angle * 5.0 + t * 0.69)
    + irregularity * (0.09 + 0.035 * u_activity);
  float edge = length(shape) - radius;
  vec2 p = turn(0.10 * sin(t * 0.7)) * uv;
  if (u_variant > 0.5 && u_variant < 1.5) {
    float left = length((p - vec2(-0.30, 0.10 * sin(t))) * vec2(1.0, 0.85)) - 0.39;
    float right = length((p - vec2(0.30, -0.10 * sin(t))) * vec2(1.0, 0.85)) - 0.39;
    float h = max(0.20 - abs(left - right), 0.0) / 0.20;
    edge = min(left, right) - h * h * 0.05;
  } else if (u_variant > 1.5 && u_variant < 2.5) {
    float ring = length(p) - (0.52 + 0.03 * sin(angle * 3.0 + t));
    edge = abs(ring) - 0.16;
  } else if (u_variant > 2.5 && u_variant < 3.5) {
    edge = (abs(p.x) + abs(p.y) - 0.83 - 0.04 * sin(t * 1.3)) * 0.707;
  } else if (u_variant > 3.5) {
    vec2 q = abs(p) - vec2(0.43, 0.60);
    edge = max(q.x, q.y);
    edge = max(edge, (p.x + p.y - 0.75) * 0.707);
  }
  float pixel = 1.4 / min(u_resolution.x, u_resolution.y);
  float alpha = 1.0 - smoothstep(-pixel, pixel, edge);
  if (alpha < 0.001) { gl_FragColor = vec4(0.0); return; }
  vec2 field = turn(0.35 * sin(t * 0.31) + t * 0.075) * uv;
  vec2 drift = vec2(0.22 * sin(t * 0.57), 0.20 * cos(t * 0.43));
  float turbulence = flowNoise(field * 2.4 + vec2(t * 0.23, -t * 0.17)) - 0.5;
  field += vec2(turbulence * 0.24, 0.12 * sin(field.x * 3.0 + t * 0.71));
  float band = length((field - vec2(0.22, -1.15) + drift) * vec2(0.88, 0.72));
  band += 0.12 * sin(field.x * 3.0 + t * 0.89)
        + 0.065 * cos(field.y * 4.0 - t * 0.63)
        + turbulence * (0.15 + u_activity * 0.08);
  vec3 color = thermalMetal(clamp((band - 0.20) / 1.35, 0.0, 1.0));
  float fineGrain = grain(gl_FragCoord.xy) - 0.5;
  float brushed = sin(gl_FragCoord.y * 2.8 + grain(vec2(floor(gl_FragCoord.y), 1.0)) * 5.0);
  color += vec3(fineGrain * 0.15 + brushed * 0.009);
  gl_FragColor = vec4(clamp(color, 0.0, 1.0), alpha);
}
`;

export function createRenderer(canvas: HTMLCanvasElement, variant: MarkVariant) {
  const gl = canvas.getContext("webgl", { alpha: true, antialias: true, depth: false, stencil: false, premultipliedAlpha: false, powerPreference: "low-power" });
  if (!gl) return null;
  const shaders: WebGLShader[] = [];
  let program: WebGLProgram | null = null;
  let buffer: WebGLBuffer | null = null;
  const dispose = () => {
    if (buffer) gl.deleteBuffer(buffer);
    if (program) gl.deleteProgram(program);
    shaders.forEach((s) => gl.deleteShader(s));
  };
  try {
    for (const [type, source] of [
      [gl.VERTEX_SHADER, vertexSource],
      [gl.FRAGMENT_SHADER, fragmentSource],
    ] as const) {
      const shader = gl.createShader(type);
      if (!shader) throw new Error("Unable to allocate shader");
      shaders.push(shader);
      gl.shaderSource(shader, source);
      gl.compileShader(shader);
      if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) throw new Error("Unable to compile mark");
    }
    program = gl.createProgram();
    if (!program) throw new Error("Unable to allocate program");
    for (const s of shaders) gl.attachShader(program, s);
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error("Unable to link mark");
    buffer = gl.createBuffer();
    if (!buffer) throw new Error("Unable to allocate geometry");
    gl.useProgram(program);
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    const position = gl.getAttribLocation(program, "a_position");
    gl.enableVertexAttribArray(position);
    gl.vertexAttribPointer(position, 2, gl.FLOAT, false, 0, 0);
    const resolution = gl.getUniformLocation(program, "u_resolution");
    const time = gl.getUniformLocation(program, "u_time");
    const activity = gl.getUniformLocation(program, "u_activity");
    const shapeVariant = gl.getUniformLocation(program, "u_variant");
    const linked = program;
    return {
      draw(seconds: number, intensity: number) {
        const pixels = Math.min(256, Math.max(32, Math.round(canvas.clientWidth * Math.min(devicePixelRatio || 1, 1.5))));
        if (canvas.width !== pixels || canvas.height !== pixels) {
          canvas.width = pixels;
          canvas.height = pixels;
        }
        gl.viewport(0, 0, pixels, pixels);
        gl.useProgram(linked);
        gl.uniform2f(resolution, pixels, pixels);
        gl.uniform1f(time, seconds);
        gl.uniform1f(activity, intensity);
        gl.uniform1f(shapeVariant, markVariants.indexOf(variant));
        gl.drawArrays(gl.TRIANGLES, 0, 3);
      },
      dispose,
    };
  } catch {
    dispose();
    return null;
  }
}

export function ThermalMark({
  size = 40,
  state = "idle",
  animated = true,
  variant = "blob",
  label,
}: {
  size?: number;
  state?: MarkState;
  animated?: boolean;
  variant?: MarkVariant;
  /** Accessible name; omit for a decorative mark next to its own label. */
  label?: string;
}) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const stateRef = useRef(state);
  stateRef.current = state;
  const [ready, setReady] = useState(false);
  const pattern = `thermal-${useId().replace(/:/g, "")}`;

  useEffect(() => {
    const element = canvas.current;
    if (!element || !animated) return;
    let renderer = createRenderer(element, variant);
    if (!renderer) return;
    let frame = 0;
    let lastFrame = 0;
    let phase = 2.7;
    let intensity = 0;
    let visible = true;
    let lost = false;
    const reduced = matchMedia("(prefers-reduced-motion: reduce)");
    const draw = () => {
      renderer?.draw(phase, intensity);
      setReady(true);
    };
    const cancel = () => {
      cancelAnimationFrame(frame);
      frame = 0;
      lastFrame = 0;
    };
    const animate = (timestamp: number) => {
      frame = 0;
      if (!visible || document.hidden || lost || reduced.matches) return;
      if (!lastFrame || timestamp - lastFrame >= 1000 / 30) {
        const dt = lastFrame ? Math.min((timestamp - lastFrame) / 1000, 0.1) : 0;
        const s = stateRef.current;
        const target = s === "working" ? 1 : s === "waiting" ? 0.15 : 0;
        intensity += (target - intensity) * Math.min(dt * 1.4, 1);
        phase += dt * (s === "queued" ? 0.3 : s === "waiting" ? 0.65 : s === "user" ? 0.55 : 1.25 + intensity * 0.8);
        lastFrame = timestamp;
        renderer?.draw(phase, intensity);
      }
      frame = requestAnimationFrame(animate);
    };
    const resume = () => {
      cancel();
      if (!lost) draw();
      if (visible && !document.hidden && !lost && !reduced.matches) frame = requestAnimationFrame(animate);
    };
    const observer =
      typeof IntersectionObserver !== "undefined"
        ? new IntersectionObserver(([entry]) => {
            visible = Boolean(entry?.isIntersecting);
            resume();
          })
        : null;
    observer?.observe(element);
    const resize = new ResizeObserver(() => {
      if (!lost) draw();
    });
    resize.observe(element);
    const onLost = (event: Event) => {
      event.preventDefault();
      lost = true;
      cancel();
      renderer = null;
      setReady(false);
    };
    const onRestored = () => {
      renderer = createRenderer(element, variant);
      lost = !renderer;
      resume();
    };
    element.addEventListener("webglcontextlost", onLost);
    element.addEventListener("webglcontextrestored", onRestored);
    document.addEventListener("visibilitychange", resume);
    reduced.addEventListener("change", resume);
    resume();
    return () => {
      cancel();
      observer?.disconnect();
      resize.disconnect();
      document.removeEventListener("visibilitychange", resume);
      reduced.removeEventListener("change", resume);
      element.removeEventListener("webglcontextlost", onLost);
      element.removeEventListener("webglcontextrestored", onRestored);
      renderer?.dispose();
    };
  }, [animated, variant]);

  return (
    <span
      className={`thermal-mark ${ready && animated ? "is-rendered" : ""}`}
      role={label ? "img" : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
      style={{ "--mark-size": `${size}px` } as CSSProperties}
    >
      <svg className="thermal-mark-fallback" viewBox="0 0 100 100" aria-hidden="true">
        <defs>
          <pattern id={pattern} width="100" height="100" patternUnits="userSpaceOnUse">
            <image href="/thermal-metal.svg" x="-39" width="178" height="100" preserveAspectRatio="none" />
          </pattern>
        </defs>
        <path d={markPaths[variant]} fillRule="evenodd" fill={`url(#${pattern})`} />
      </svg>
      {animated && <canvas ref={canvas} className="thermal-mark-canvas" aria-hidden="true" />}
    </span>
  );
}

/** An agent's state (lib/agent-state) as a small thermal mark with an accessible label: the same everywhere. */
export function StatusMark({ state }: { state: AgentState }) {
  const map = {
    working: { mark: "working", variant: "blob" },
    "needs-you": { mark: "waiting", variant: "connection" },
    queued: { mark: "queued", variant: "workflow" },
    idle: { mark: "idle", variant: "blob" },
    new: { mark: "idle", variant: "blob" },
    failed: { mark: "idle", variant: "command" },
    stopped: { mark: "idle", variant: "workflow" },
  } as const;
  const m = map[state];
  const label = AGENT_LABEL[state].replace(/^\w/, (c) => c.toUpperCase());
  return (
    <span className={`status-mark is-${state}`} role="status" aria-label={label} title={label}>
      <ThermalMark size={20} state={m.mark} variant={m.variant} animated={state === "working" || state === "needs-you"} />
    </span>
  );
}

/** Decorative family mark for an action awaiting approval; the title next to it carries the name. */
export function ActionMark({ tool }: { tool: string }) {
  const variant: MarkVariant = /^mcp__/.test(tool) ? "connection" : /Bash|shell|command/i.test(tool) ? "command" : /Write|Edit|file/i.test(tool) ? "file" : "blob";
  return (
    <span className="action-mark" aria-hidden="true">
      <ThermalMark size={24} variant={variant} state="waiting" />
    </span>
  );
}
