/**
 * Typed client for the WindTunnel backend REST API.
 * Mirrors docs/CONTRACT.md exactly. All requests go through the Vite dev
 * proxy: /api -> http://localhost:8000.
 */

export type RunStatus =
  | "queued"
  | "preparing"
  | "meshing"
  | "solving"
  | "postprocessing"
  | "done"
  | "error";

export type StlUnit = "mm" | "cm" | "m" | "in";
export type Quality = "coarse" | "medium" | "fine";

/** Config JSON string posted with the STL (POST /api/runs). */
export interface RunConfig {
  name: string;
  unit: StlUnit;
  wind_speed: number;
  yaw_deg: number;
  quality: Quality;
  rho?: number;
  nu?: number;
}

/** Item of GET /api/runs */
export interface RunSummary {
  id: string;
  name: string;
  status: RunStatus;
  progress: number;
  created_at: number;
  wind_speed: number;
  quality: Quality;
}

export interface ModelInfo {
  bbox_m: [[number, number, number], [number, number, number]];
  /** Wind tunnel domain extents (meters); present on run detail responses. */
  domain_bbox_m?: [[number, number, number], [number, number, number]];
  frontal_area_m2: number;
  triangles: number;
}

/** GET /api/runs/{id}/result (also embedded in RunDetail.result when done) */
export interface RunResult {
  cd: number;
  cl: number;
  cs: number;
  drag_N: number;
  lift_N: number;
  side_N: number;
  frontal_area_m2: number;
  wind_speed: number;
  rho: number;
  iterations: number;
  mesh_cells: number;
  runtime_s: number;
  cd_std_last20pct: number;
}

/** GET /api/runs/{id} */
export interface RunDetail {
  id: string;
  name: string;
  status: RunStatus;
  progress: number;
  message: string;
  config: RunConfig;
  model: ModelInfo | null;
  mesh_cells: number | null;
  result: RunResult | null;
  error: string | null;
}

/** GET /api/runs/{id}/log?tail=N */
export interface LogTail {
  stage: string;
  lines: string[];
  total: number;
}

/** GET /api/runs/{id}/history */
export interface History {
  iters: number[];
  cd: number[];
  cl: number[];
  residuals: {
    iters: number[];
    p: number[];
    Ux: number[];
    k: number[];
    omega: number[];
  };
}

/** Flat-array mesh payloads for three.js BufferGeometry. */
export interface VizSurface {
  positions: number[];
  indices: number[];
  fields: { p: number[]; cp: number[] };
  ranges: { p: [number, number]; cp: [number, number] };
}

export interface VizSlice {
  positions: number[];
  indices: number[];
  fields: { u_mag: number[]; p: number[] };
  ranges: { u_mag: [number, number]; p: [number, number] };
  /** Echoed back for on-demand slices (pos clamped into the domain). */
  axis?: SliceAxis;
  pos?: number;
}

/** GET /api/runs/{id}/viz/streamlines — polyline tracks, u_mag per vertex. */
export interface VizStreamlines {
  positions: number[];
  lines: number[][];
  fields: { u_mag: number[] };
  ranges: { u_mag: [number, number] };
}

export type SliceAxis = "x" | "y" | "z";

/** Error thrown for non-2xx responses (has the HTTP status). */
export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
  }
}

/** Thrown when the backend cannot be reached at all (fetch rejected). */
export class BackendUnreachableError extends Error {
  constructor() {
    super("Backend unreachable");
    this.name = "BackendUnreachableError";
  }
}

const BASE = "/api";

async function request(path: string, init?: RequestInit): Promise<Response> {
  let res: Response;
  try {
    res = await fetch(`${BASE}${path}`, init);
  } catch {
    throw new BackendUnreachableError();
  }
  // The Vite proxy answers 502/504 itself when the backend is down.
  if (res.status === 502 || res.status === 504) {
    throw new BackendUnreachableError();
  }
  if (!res.ok) {
    let detail = res.statusText;
    try {
      const body = await res.json();
      if (typeof body?.detail === "string") detail = body.detail;
      else if (typeof body?.error === "string") detail = body.error;
    } catch {
      /* not JSON */
    }
    throw new ApiError(res.status, detail || `HTTP ${res.status}`);
  }
  return res;
}

async function getJson<T>(path: string): Promise<T> {
  const res = await request(path);
  return (await res.json()) as T;
}

export const api = {
  /** POST /api/runs — multipart: `stl` file + `config` JSON string. */
  async createRun(stl: File, config: RunConfig): Promise<{ id: string }> {
    const form = new FormData();
    form.append("stl", stl, stl.name);
    form.append("config", JSON.stringify(config));
    const res = await request("/runs", { method: "POST", body: form });
    return (await res.json()) as { id: string };
  },

  listRuns(): Promise<RunSummary[]> {
    return getJson<RunSummary[]>("/runs");
  },

  getRun(id: string): Promise<RunDetail> {
    return getJson<RunDetail>(`/runs/${id}`);
  },

  getLog(id: string, tail = 200): Promise<LogTail> {
    return getJson<LogTail>(`/runs/${id}/log?tail=${tail}`);
  },

  getHistory(id: string): Promise<History> {
    return getJson<History>(`/runs/${id}/history`);
  },

  getResult(id: string): Promise<RunResult> {
    return getJson<RunResult>(`/runs/${id}/result`);
  },

  /** Original uploaded STL (original units, uncentered). */
  async getStl(id: string): Promise<ArrayBuffer> {
    const res = await request(`/runs/${id}/stl`);
    return await res.arrayBuffer();
  },

  getVizSurface(id: string): Promise<VizSurface> {
    return getJson<VizSurface>(`/runs/${id}/viz/surface`);
  },

  getVizSlice(id: string, axis: SliceAxis, pos?: number): Promise<VizSlice> {
    const q = pos !== undefined ? `&pos=${pos}` : "";
    return getJson<VizSlice>(`/runs/${id}/viz/slice?axis=${axis}${q}`);
  },

  getVizStreamlines(id: string): Promise<VizStreamlines> {
    return getJson<VizStreamlines>(`/runs/${id}/viz/streamlines`);
  },

  async deleteRun(id: string): Promise<void> {
    await request(`/runs/${id}`, { method: "DELETE" });
  },
};
