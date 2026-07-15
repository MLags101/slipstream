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
  /**
   * v2: 2-8 yaw angles (degrees). Creates one run per angle sharing a fresh
   * group_id; `yaw_deg` is ignored when present.
   */
  yaw_sweep?: number[];
  /** Positive pitch = nose-down forward-flight tilt. */
  pitch_deg?: number;
  /** v2.1: like yaw_sweep but about the pitch axis (mutually exclusive). */
  pitch_sweep?: number[];
  /**
   * v3: propeller actuator disks (powered flow). Coordinates/diameter in the
   * STL's own units, thrust in grams; thrust axis is the model's +Z (rotates
   * with pitch/yaw).
   */
  props?: PropSpec[];
  /** Reference area (cm²) for force coefficients; defaults to frontal area. */
  ref_area_cm2?: number;
  /**
   * v3.1: solve the forward-flight trim attitude. Requires `props`; mutually
   * exclusive with sweeps. The backend iterates runs (shared group) adjusting
   * pitch and per-prop thrust until equilibrium.
   */
  trim?: { weight_g: number; max_iters?: number; tol_deg?: number };
}

export interface PropSpec {
  center: [number, number, number];
  diameter: number;
  thrust_g: number;
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
  /** v2: set when the run belongs to a yaw sweep. */
  group_id: string | null;
  yaw_deg: number;
}

/**
 * POST /api/runs response. Plain runs return just `id`; a yaw sweep also
 * carries the shared `group_id` and all member `ids` (`id` = first member).
 */
export interface CreateRunResponse {
  id: string;
  group_id?: string;
  ids?: string[];
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
  /** Reference area used for the coefficients (frontal, or an override). */
  ref_area_m2?: number;
  wind_speed: number;
  rho: number;
  iterations: number;
  mesh_cells: number;
  runtime_s: number;
  cd_std_last20pct: number;
  /** v2 drag breakdown — null for runs solved before the feature. */
  drag_pressure_N: number | null;
  drag_viscous_N: number | null;
  /** v2: true when the solver auto-stopped on Cd convergence. */
  stopped_early: boolean;
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
  /** v2: set when the run belongs to a yaw sweep. */
  group_id: string | null;
}

/** Member entry of GET /api/groups/{group_id} (sorted by yaw). */
export interface GroupMember {
  id: string;
  yaw_deg: number;
  /** The swept angle (yaw or pitch, per GroupDetail.param). */
  angle?: number;
  status: RunStatus;
  progress: number;
  /** null until that member is done. */
  cd: number | null;
  drag_N: number | null;
}

/** v3.1: trim solver progress/result (GroupDetail.trim for trim groups). */
export interface TrimSummary {
  /** true/false once the solver finished; null while still trimming. */
  converged: boolean | null;
  iterations: number;
  trim_pitch_deg?: number;
  tilt_deg?: number;
  total_thrust_N?: number | null;
  thrust_g_per_prop?: number | null;
  drag_N?: number | null;
  lift_N?: number | null;
  weight_g?: number;
  wind_speed?: number;
  history?: {
    pitch_deg: number;
    drag_N: number;
    lift_N: number;
    thrust_g_per_prop: number;
  }[];
  error?: string | null;
}

/** GET /api/groups/{group_id} — yaw sweep summary. */
export interface GroupDetail {
  group_id: string;
  name: string;
  /** Which angle the sweep varies; "yaw" for pre-v2.1 groups. */
  param?: "yaw" | "pitch";
  /** v3.1: "trim" for trim-solver groups (members are iterations). */
  kind?: "sweep" | "trim";
  wind_speed: number;
  quality: Quality;
  runs: GroupMember[];
  /** v3.1: present for trim groups (partial while iterating). */
  trim?: TrimSummary;
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
export type StreamDensity = "low" | "med" | "high";
export type StreamRegion = "full" | "core";

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

/** GET /api/storage — run-store disk usage. */
export interface StorageInfo {
  total_bytes: number;
  run_count: number;
  finished_count: number;
  reclaimable_bytes: number;
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
  getStorage(): Promise<StorageInfo> {
    return getJson<StorageInfo>("/storage");
  },

  async pruneRuns(): Promise<{ deleted: string[]; freed_bytes: number }> {
    const res = await request("/runs/prune", { method: "POST" });
    return (await res.json()) as { deleted: string[]; freed_bytes: number };
  },

  /** POST /api/runs — multipart: `stl` file + `config` JSON string. */
  async createRun(stl: File, config: RunConfig): Promise<CreateRunResponse> {
    const form = new FormData();
    form.append("stl", stl, stl.name);
    form.append("config", JSON.stringify(config));
    const res = await request("/runs", { method: "POST", body: form });
    return (await res.json()) as CreateRunResponse;
  },

  listRuns(): Promise<RunSummary[]> {
    return getJson<RunSummary[]>("/runs");
  },

  getRun(id: string): Promise<RunDetail> {
    return getJson<RunDetail>(`/runs/${id}`);
  },

  /** Yaw sweep group summary (member statuses + Cd/drag as they finish). */
  getGroup(groupId: string): Promise<GroupDetail> {
    return getJson<GroupDetail>(`/groups/${groupId}`);
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

  getVizStreamlines(
    id: string,
    density: StreamDensity = "med",
    region: StreamRegion = "full",
  ): Promise<VizStreamlines> {
    return getJson<VizStreamlines>(
      `/runs/${id}/viz/streamlines?density=${density}&region=${region}`,
    );
  },

  async deleteRun(id: string): Promise<void> {
    await request(`/runs/${id}`, { method: "DELETE" });
  },
};
