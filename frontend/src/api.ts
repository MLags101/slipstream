/**
 * Typed client for the Slipstream backend REST API.
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
  | "error"
  | "cancelled";

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
  /**
   * Roll about X, applied before pitch and yaw. Incompatible with half-model
   * symmetry, which needs the model level in the Y=0 mirror plane.
   */
  roll_deg?: number;
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
  /** Place a road under the model (ground effect) — for cars/vehicles. */
  ground_plane?: boolean;
  /** Ground type when ground_plane is set: "moving" rolling road (default) or "static". */
  ground?: "moving" | "static";
  /**
   * Half-model symmetry: solve only the +Y half of the domain with a symmetry
   * plane at Y=0 (the X-Z plane), ~2× faster. Valid only for symmetric models
   * at 0° yaw, without props/trim/yaw-sweep.
   */
  symmetry?: boolean;
  /**
   * v3.1: solve the forward-flight trim attitude. Requires `props`; mutually
   * exclusive with sweeps. The backend iterates runs (shared group) adjusting
   * pitch and per-prop thrust until equilibrium.
   */
  trim?: { weight_g: number; max_iters?: number; tol_deg?: number };
  /**
   * v8: mesh-independence sweep. Runs coarse -> medium -> fine (shared group)
   * and stops once one refinement changes Cd by <= tol_pct. `quality` is set
   * per member. Mutually exclusive with sweeps and trim.
   */
  mesh_sweep?: { tol_pct?: number };
  /**
   * v8.1: optional extra mesh refinement. `long_wake` carries the wake
   * refinement 4 body lengths back (plus a coarser zone to 8L);
   * `prop_slipstream` adds a refined cylinder along each prop's slipstream
   * (requires `props`).
   */
  refinement?: RefinementOptions;
  /**
   * v8.5: prism (boundary) layer stack grown on the wall patches. These set
   * y+, so they decide whether the wall functions are being used in their
   * valid range. Omit for the defaults (3 layers, ratio 1.2).
   */
  layers?: LayerOptions;
  /** v8.4: the run solves on an imported mesh instead of meshing an STL. */
  mesh_import?: {
    filename: string;
    format: string;
    source_unit: string;
    cells: number;
    roles: Record<string, MeshRole>;
  };
  /** v8.2: set on re-solves — the run whose mesh this one reused. */
  mesh_from?: string;
  /** v8.2: original run name that re-solve names are built from. */
  resolve_base_name?: string;
}

/** Role of a boundary patch in an imported mesh. */
export type MeshRole = "inlet" | "outlet" | "model" | "slip" | "wall" | "symmetry";

/** POST /api/mesh/inspect: an uploaded volume mesh, converted and checked. */
export interface MeshInspection {
  id: string;
  filename: string;
  format: "gmsh" | "fluent" | "polymesh_zip";
  unit: string;
  cells: number;
  bounds_m: [[number, number, number], [number, number, number]] | null;
  mesh_ok: boolean;
  failed_checks: number;
  patches: {
    name: string;
    type: string;
    faces: number;
    center_m: [number, number, number] | null;
  }[];
  suggested_roles: Record<string, MeshRole>;
}

/** POST /api/runs/import body. */
export interface ImportRunRequest {
  import_id: string;
  roles: Record<string, MeshRole>;
  wind_speed: number;
  /** Iteration budget: coarse 250, medium 500, fine 800. */
  quality: Quality;
  name?: string;
  ref_area_cm2?: number;
}

/** POST /api/runs/{id}/resolve body: only inputs that leave the mesh unchanged. */
export interface ResolveRequest {
  wind_speed?: number;
  /** Grams per prop: one value for every prop, or one per prop. */
  thrust_g?: number | number[];
  name?: string;
}

export interface RefinementOptions {
  long_wake?: boolean;
  prop_slipstream?: boolean;
}

/**
 * v8.5: prism layer stack. Thicknesses are fractions of the local surface
 * cell (snappyHexMesh relativeSizes), not absolute lengths.
 */
export interface LayerOptions {
  /** Layers grown on the model. 0 disables the layer stage entirely. */
  count?: number;
  /** Growth ratio between consecutive layers. */
  expansion?: number;
  /** Outermost layer thickness, as a fraction of the surface cell. */
  final_thickness?: number;
  /** Thinnest acceptable layer; snappy drops the stack below this. */
  min_thickness?: number;
  /** Also grow layers on the floor. Requires ground_plane. */
  ground?: boolean;
  /**
   * v8.6: aim the first cell at this y+. Switches the stack to absolute
   * sizing (first layer in meters, from a flat-plate friction estimate)
   * instead of a fraction of the surface cell. Requires `count`.
   */
  target_y_plus?: number;
}

/** v8.6: what a requested y+ target worked out to for a run. */
export interface LayerTarget {
  target_y_plus: number;
  /** First layer height snappyHexMesh was given, in meters. */
  first_layer_m: number;
  expansion: number;
  /** The requested count; `counts` holds what each patch could actually take. */
  count: number;
  /** Layers per patch, derived from the local cell size. */
  counts?: Record<string, number>;
  /** Cell size each patch's layers grow from, in meters. */
  patch_cell_m?: Record<string, number>;
  /**
   * Patches whose cells are too coarse to reach the target. Only a finer
   * surface mesh fixes these — more layers will not.
   */
  unreachable?: string[];
}

/** What the backend actually meshed for `config.refinement`. */
export interface RefinementInfo {
  long_wake: { level2_end_m: number; level1_end_m: number } | null;
  slipstreams: { level: number; cell_mm: number; direction: [number, number, number] }[];
}

/** POST /api/stl/props: motors found in a multirotor STL. */
export interface PropDetection {
  props: { center: [number, number, number]; diameter: number }[];
  motor_radius?: number;
  /** Why nothing was found (props is then empty). */
  reason: string | null;
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
  /** False if the STL isn't a closed, manifold surface (may mesh poorly). */
  watertight?: boolean;
  /** True if the model is Y-symmetric enough to solve as a half-model. */
  symmetric?: boolean;
  /** Measured asymmetry across the Y=0 plane (smaller = more symmetric). */
  symmetry_error?: number;
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
  /**
   * v7.1: false when Cd never settled, so `cd` is the average of a moving
   * number rather than a result — do not present it as one. Undefined for runs
   * solved before the flag existed.
   */
  converged?: boolean;
  /** v2 drag breakdown — null for runs solved before the feature. */
  drag_pressure_N: number | null;
  drag_viscous_N: number | null;
  /** v2: true when the solver auto-stopped on Cd convergence. */
  stopped_early: boolean;
  /** True when solved as a half-model with a Y=0 symmetry plane. */
  symmetry?: boolean;
  /** Reynolds number on the model's streamwise length. */
  reynolds?: number;
  mesh_quality?: {
    max_non_ortho?: number;
    max_skewness?: number;
    ok?: boolean;
    rating?: "good" | "fair" | "poor";
  };
  /**
   * v8.5: y+ per wall patch, measured on the converged solution. Undefined or
   * null for runs solved before this existed, or when postProcess failed.
   */
  y_plus?: Record<string, { min: number; max: number; average: number }> | null;
  /**
   * The model patch's average y+ bucketed against the wall-function range:
   * "low" under 30, "ok" to 300, "high" above.
   */
  y_plus_verdict?: "low" | "ok" | "high" | null;
  /**
   * v8.6: what the layer stack achieved per patch, not what was requested.
   * A low `coverage_pct` means a patchy stack, which is worse than none.
   */
  layer_coverage?: Record<
    string,
    { layers: number; layers_requested: number; coverage_pct: number }
  > | null;
}

/** GET /api/runs/{id} */
/** POST /api/stl/inspect: is the surface closed enough to mesh cleanly? */
export interface StlInspection {
  triangles: number;
  watertight: boolean;
  /** Edges used by only one face (holes). */
  open_edges: number;
  /** Edges shared by three or more faces (overlapping/touching shells). */
  non_manifold_edges: number;
  bodies: number;
}

/** Result of a model repair; lengths are in the STL's own units. */
export interface RepairReport {
  pitch: number;
  triangles_in: number;
  triangles_out: number;
  open_edges_in: number;
  non_manifold_edges_in: number;
  watertight: boolean;
  bodies: number;
  decimator: string;
  alignment_shift: [number, number, number];
  /** Median signed surface shift vs the original (+ = fatter). */
  shift_median: number;
  deviation_p95: number;
  deviation_max: number;
  runtime_s: number;
}

export interface RepairJob {
  id: string;
  status: "running" | "done" | "error";
  progress: number;
  stage: string;
  report: RepairReport | null;
  error: string | null;
}

/** A prop disk in the prepared model frame (meters), as the solver placed it. */
export interface PropDiskM {
  center_m: [number, number, number];
  /** Unit thrust axis (downwash flows the opposite way). */
  axis: [number, number, number];
  diameter_m: number;
  thrust_N: number;
}

export interface RunDetail {
  id: string;
  name: string;
  status: RunStatus;
  progress: number;
  message: string;
  config: RunConfig;
  model: ModelInfo | null;
  /** Prop disks transformed into the viz frame; null when the run has none. */
  props_m?: PropDiskM[] | null;
  /** v8.1: refinement actually meshed (null when none was requested). */
  refinement?: RefinementInfo | null;
  /** v8.6: what a y+ target worked out to (null when none was set). */
  layer_target?: LayerTarget | null;
  /** v8.2: the finished mesh is on disk, so the run can be re-solved on it. */
  has_mesh?: boolean;
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
  /** v8.5: lift, so a pitch sweep reads as a polar. null until done. */
  cl?: number | null;
  lift_N?: number | null;
  /** v8: mesh quality of this member (meaningful for mesh sweeps). */
  quality?: Quality;
  /** v8: cell count once done. */
  mesh_cells?: number | null;
}

/** v8: one finished step of a mesh-independence sweep. */
export interface MeshSweepStep {
  quality: Quality;
  mesh_cells: number | null;
  cd: number;
  drag_N: number | null;
  converged: boolean | null;
  /** Cd change vs the previous (coarser) step, percent; null for the first. */
  change_pct: number | null;
}

/** v8: mesh-independence sweep progress/result (GroupDetail.mesh). */
export interface MeshSweepSummary {
  /** null while still refining. */
  status: "independent" | "not_independent" | "failed" | null;
  /** Coarsest mesh whose Cd the next refinement confirmed within tol. */
  independent_at?: Quality | null;
  /** Cd of the finest finished run (the best estimate). */
  best_cd?: number | null;
  tol_pct?: number | null;
  steps?: number;
  history?: MeshSweepStep[];
  error?: string | null;
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
  param?: "yaw" | "pitch" | "quality";
  /** v3.1: "trim" for trim-solver groups (members are iterations). */
  kind?: "sweep" | "trim" | "mesh";
  wind_speed: number;
  quality: Quality;
  runs: GroupMember[];
  /** v3.1: present for trim groups (partial while iterating). */
  trim?: TrimSummary;
  /** v8: present for mesh-independence sweeps (partial while refining). */
  mesh?: MeshSweepSummary;
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
  /** Space freed by compacting (dropping meshes, keeping results + viz). */
  compactable_bytes: number;
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

  async compactRuns(): Promise<{ compacted: string[]; freed_bytes: number }> {
    const res = await request("/runs/compact", { method: "POST" });
    return (await res.json()) as { compacted: string[]; freed_bytes: number };
  },

  async cancelRun(id: string): Promise<void> {
    await request(`/runs/${id}/cancel`, { method: "POST" });
  },

  async rerunRun(id: string): Promise<{ id: string }> {
    const res = await request(`/runs/${id}/rerun`, { method: "POST" });
    return (await res.json()) as { id: string };
  },

  /** Convert and check an uploaded volume mesh, listing its patches. */
  async inspectMesh(mesh: File, unit: string): Promise<MeshInspection> {
    const form = new FormData();
    form.append("mesh", mesh, mesh.name);
    form.append("unit", unit);
    const res = await request("/mesh/inspect", { method: "POST", body: form });
    return (await res.json()) as MeshInspection;
  },

  async importRun(body: ImportRunRequest): Promise<{ id: string }> {
    const res = await request("/runs/import", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    return (await res.json()) as { id: string };
  },

  /** Suggest prop disks on a multirotor's motors (positions in STL units). */
  async detectProps(stl: File, unit: string): Promise<PropDetection> {
    const form = new FormData();
    form.append("stl", stl, stl.name);
    form.append("unit", unit);
    const res = await request("/stl/props", { method: "POST", body: form });
    return (await res.json()) as PropDetection;
  },

  async renameRun(id: string, name: string): Promise<RunDetail> {
    const res = await request(`/runs/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name }),
    });
    return (await res.json()) as RunDetail;
  },

  /** Solve again on this run's mesh with a new wind speed and/or thrust. */
  async resolveRun(id: string, body: ResolveRequest): Promise<{ id: string }> {
    const res = await request(`/runs/${id}/resolve`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    return (await res.json()) as { id: string };
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
  /** POST /api/stl/inspect — quick closed-surface check of an STL. */
  async inspectStl(stl: File): Promise<StlInspection> {
    const form = new FormData();
    form.append("stl", stl, stl.name);
    const res = await request("/stl/inspect", { method: "POST", body: form });
    return (await res.json()) as StlInspection;
  },

  /** POST /api/repair — start rebuilding an STL as a closed solid. */
  async startRepair(stl: File): Promise<{ id: string }> {
    const form = new FormData();
    form.append("stl", stl, stl.name);
    const res = await request("/repair", { method: "POST", body: form });
    return (await res.json()) as { id: string };
  },

  getRepair(id: string): Promise<RepairJob> {
    return getJson<RepairJob>(`/repair/${id}`);
  },

  async getRepairStl(id: string): Promise<ArrayBuffer> {
    const res = await request(`/repair/${id}/stl`);
    return await res.arrayBuffer();
  },

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
