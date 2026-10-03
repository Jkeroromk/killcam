import { invoke, convertFileSrc } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

export type EventKind = "kill" | "knock" | "death" | "knocked" | "win" | "manual";

export interface EventRule {
  enabled: boolean;
  pre: number;
  post: number;
}

export interface Settings {
  onboarded: boolean;
  ffmpegPath: string | null;
  libraryDir: string;
  storageLimitGb: number;
  captureMode: "full" | "highlights";
  autoRecord: boolean;
  video: {
    monitorIndex: number;
    monitorWidth: number;
    monitorHeight: number;
    preset: "performance" | "balanced" | "quality" | "custom";
    height: number;
    fps: number;
    bitrateMbps: number;
    encoder: string;
    aspect: "native" | "16:9";
  };
  audio: AudioSettings;
  events: Record<EventKind, EventRule>;
  pubg: { playerName: string; apiKey: string; shard: string; accountId: string | null };
  hotkeys: { highlight: string; toggleRecord: string };
  telemetryOffsetMs: number;
  screenDetect: boolean;
  miniWindow: boolean;
  launchAtLogin: boolean;
  /** short sound when F9 marks a highlight */
  markerSound: boolean;
}

export interface AudioSettings {
  gameSource: "process" | "system" | "off";
  gameVolume: number;
  micEnabled: boolean;
  micDeviceId: string | null;
  systemDeviceId: string | null;
  micVolume: number;
}

export interface LiveStats {
  frame: number;
  fps: number;
  speed: number;
  dropFrames: number;
  dupFrames: number;
  sizeBytes: number;
  outTimeS: number;
  reports: number;
}

export interface Status {
  recording: boolean;
  sessionId: string | null;
  startedAtMs: number | null;
  elapsedS: number;
  stats: LiveStats;
  width: number;
  height: number;
  encoder: string;
  markers: number;
  detections: number;
  liveKills: number;
  liveKnocks: number;
  /** off | uncalibrated | active | error text */
  detector: string;
  gameRunning: boolean;
  autoSession: boolean;
  processing: string | null;
  waitingMinutes: number | null;
  lastError: string | null;
  warnings: string[];
  notices: string[];
  onboarded: boolean;
  /** a newer KillCam is published */
  update: UpdateInfo | null;
  version: string;
}

export interface UpdateInfo {
  version: string;
  current: string;
  notes: string | null;
}

export interface FfmpegInfo {
  path: string;
  version: string;
  hasDdagrab: boolean;
  hasScaleD3d11: boolean;
}

export interface EncoderInfo {
  id: string;
  label: string;
  vendor: string;
  available: boolean;
  /** works only with the image converted on the CPU first (some AMD drivers) */
  cpuFeed?: boolean;
}

export interface DiskInfo {
  mount: string;
  total: number;
  free: number;
  isSystem: boolean;
}

export interface HardwareInfo {
  gpu: string;
  cpuThreads: number;
  ffmpeg: FfmpegInfo | null;
  ffmpegError: string | null;
  gpuScaleWorks: boolean;
  encoders: EncoderInfo[];
  disks: DiskInfo[];
}

export interface MonitorInfo {
  index: number;
  width: number;
  height: number;
  thumbnail: string;
}

export interface GameInfo {
  running: boolean;
  pid: number | null;
  configFound: boolean;
  fullscreenMode: number | null;
  resolution: string | null;
  frameLimit: string | null;
}

export interface AudioDevice {
  id: string;
  name: string;
  isDefault: boolean;
}

export interface Levels {
  game: number;
  mic: number;
  gameError: string | null;
  micError: string | null;
}

export interface PerfProgress {
  elapsed: number;
  total: number;
  fps: number;
  speed: number;
  cpu: number;
}

export interface PerfResult {
  ok: boolean;
  targetFps: number;
  avgFps: number;
  speed: number;
  dropFrames: number;
  dupFrames: number;
  frames: number;
  cpuPercent: number;
  bitrateMbps: number;
  mbPerMinute: number;
  width: number;
  height: number;
  encoder: string;
  gameRunning: boolean;
  videoPath: string | null;
  warnings: string[];
  log: string;
}

export interface GameEvent {
  id: string;
  kind: EventKind;
  t: number;
  wallMs: number;
  victim: string | null;
  weapon: string | null;
  distanceM: number | null;
  headshot: boolean;
  source: string;
}

export interface Highlight {
  id: string;
  start: number;
  end: number;
  kinds: EventKind[];
  title: string;
  file: string | null;
  /** match time of the clip's first frame */
  fileStart?: number | null;
  thumb?: string | null;
  /** what the rules picked, set once trimmed */
  origStart?: number | null;
  origEnd?: number | null;
}

/** Footage a highlight can be trimmed within (mirrors library::highlight_bounds). */
export function highlightBounds(m: { video: string | null; durationS: number }, h: Highlight): [number, number] {
  if (m.video) return [0, Math.max(m.durationS, h.end)];
  return [Math.min(h.fileStart ?? h.origStart ?? h.start, h.start), Math.max(h.origEnd ?? h.end, h.end)];
}

export interface MatchStats {
  kills: number;
  knocks: number;
  damage: number;
  place: number;
  teams: number;
  headshots: number;
  longestKill: number;
}

export interface MatchRecord {
  id: string;
  kind: "match" | "session";
  pubgMatchId: string | null;
  createdAtMs: number;
  mapName: string;
  mapLabel: string;
  gameMode: string;
  durationS: number;
  video: string | null;
  videoStartMs: number;
  events: GameEvent[];
  highlights: Highlight[];
  stats: MatchStats | null;
  favorite: boolean;
  thumbnail: string | null;
  /** folder of the still images (outside the match folder) */
  thumbDir: string;
  sizeBytes: number;
  hasGameAudio: boolean;
  hasMic: boolean;
  width: number;
  height: number;
  encoder: string;
  dir: string;
}

export interface ExportOptions {
  aspect: "source" | "16:9" | "9:16";
  height: number;
  audio: "mix" | "all";
  /** keep the file under this many MB (Discord / WeChat); 0 = no limit */
  sizeMb: number;
}

export interface StorageInfo {
  libraryDir: string;
  usedBytes: number;
  limitGb: number;
  freeBytes: number;
}

export const api = {
  getSettings: () => invoke<Settings>("get_settings"),
  saveSettings: (settings: Settings) => invoke<string[]>("save_settings", { settings }),
  getStatus: () => invoke<Status>("get_status"),
  detectHardware: (force = false) => invoke<HardwareInfo>("detect_hardware", { force }),
  listMonitors: () => invoke<MonitorInfo[]>("list_monitors"),
  gameInfo: () => invoke<GameInfo>("game_info"),
  listAudioDevices: () => invoke<{ inputs: AudioDevice[]; outputs: AudioDevice[] }>("list_audio_devices"),
  startAudioMonitor: (audioSettings: AudioSettings) => invoke<void>("start_audio_monitor", { audioSettings }),
  stopAudioMonitor: () => invoke<void>("stop_audio_monitor"),
  runPerfTest: (settings: Settings, seconds?: number) => invoke<PerfResult>("run_perf_test", { settings, seconds }),
  verifyPubg: (playerName: string, apiKey: string, shard: string) =>
    invoke<{ accountId: string; recentMatches: number }>("verify_pubg", { playerName, apiKey, shard }),
  startRecording: () => invoke<void>("start_recording"),
  stopRecording: () => invoke<void>("stop_recording"),
  addMarker: () => invoke<boolean>("add_marker"),
  clearNotices: () => invoke<void>("clear_notices"),
  showMainWindow: () => invoke<void>("show_main_window"),
  closeMini: () => invoke<void>("close_mini"),
  checkUpdate: () => invoke<UpdateInfo | null>("check_update"),
  installUpdate: () => invoke<void>("install_update"),
  syncNow: (finalize = false) => invoke<void>("sync_now", { finalize }),
  listMatches: () => invoke<MatchRecord[]>("list_matches"),
  getMatch: (id: string) => invoke<MatchRecord>("get_match", { id }),
  ensureThumbs: (id: string) => invoke<MatchRecord>("ensure_thumbs", { id }),
  setFavorite: (id: string, favorite: boolean) => invoke<void>("set_favorite", { id, favorite }),
  /** start/end null = back to the rule's range */
  trimHighlight: (id: string, hid: string, start: number | null, end: number | null) =>
    invoke<MatchRecord>("trim_highlight", { id, hid, start, end }),
  deleteMatch: (id: string) => invoke<void>("delete_match", { id }),
  exportClip: (id: string, start: number, end: number, title: string, options: ExportOptions) =>
    invoke<string>("export_clip", { id, start, end, title, options }),
  exportMontage: (id: string, highlightIds: string[], options: ExportOptions) =>
    invoke<string>("export_montage", { id, highlightIds, options }),
  reveal: (path: string) => invoke<void>("reveal", { path }),
  exportDiagnostics: (path: string) => invoke<void>("export_diagnostics", { path }),
  openUrl: (url: string) => invoke<void>("open_url", { url }),
  storageInfo: () => invoke<StorageInfo>("storage_info"),
  checkFfmpeg: (path: string | null) => invoke<FfmpegInfo | null>("check_ffmpeg", { path }),
  defaultLibraryDir: () => invoke<string>("default_library_dir"),
};

export function on<T>(event: string, cb: (payload: T) => void): () => void {
  let un: UnlistenFn | null = null;
  let dead = false;
  listen<T>(event, (e) => cb(e.payload)).then((u) => {
    if (dead) u();
    else un = u;
  });
  return () => {
    dead = true;
    if (un) un();
  };
}

export function fileUrl(path: string): string {
  return convertFileSrc(path);
}

export function joinPath(dir: string, name: string): string {
  const sep = dir.includes("\\") ? "\\" : "/";
  return dir.endsWith(sep) ? dir + name : dir + sep + name;
}

export function errText(e: unknown): string {
  if (typeof e === "string") return e;
  if (e && typeof e === "object" && "message" in e) return String((e as { message: unknown }).message);
  return String(e);
}
