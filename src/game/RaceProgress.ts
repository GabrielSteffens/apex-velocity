import type { TrackGeometry, TrackProjection } from '../track/TrackGeometry';

/**
 * Tracks one competitor's progress around the lap: ordered sector checkpoints (so
 * shortcuts / reversing over the line don't count), lap counting, lap times and a
 * continuous race distance used for position ranking.
 */
export class RaceProgress {
  readonly proj: TrackProjection = { s: 0, index: -1, lateral: 0, distance: 0, height: 0 };
  /** -1 while still behind the start line on the grid. */
  lapsCompleted = -1;
  /** Index into `boundaries` of the next checkpoint to pass; boundaries.length means "finish line next". */
  nextCheckpoint: number;
  readonly boundaries: number[];
  lapStartTime = 0;
  lastLapTime = 0;
  bestLapTime = Infinity;
  lapTimes: number[] = [];
  finished = false;
  finishTime = 0;
  finishPosition = 0;
  wrongWay = false;
  private wrongWayTimer = 0;
  private prevS = -1;
  /** Seconds since the car was last on (or near) the track surface. */
  offTrackTime = 0;

  constructor(
    readonly track: TrackGeometry,
    readonly totalLaps: number,
  ) {
    // Sector checkpoints exclude s = 0 (the finish line itself).
    this.boundaries = track.checkpointPositions().slice(1);
    this.nextCheckpoint = this.boundaries.length;
  }

  get currentLap(): number {
    return Math.min(this.totalLaps, Math.max(1, this.lapsCompleted + 1));
  }

  /** Continuous distance used for ranking. */
  get raceDistance(): number {
    const L = this.track.length;
    let s = this.proj.s;
    if (this.lapsCompleted < 0) return s - L; // behind the line on the grid
    // Don't credit distance beyond a checkpoint that hasn't been validated.
    if (this.nextCheckpoint < this.boundaries.length) s = Math.min(s, this.boundaries[this.nextCheckpoint] + 1);
    return this.lapsCompleted * L + s;
  }

  /** Crossed boundary b while moving from a to a+ds (ds may be negative). */
  private crossed(a: number, ds: number, b: number): boolean {
    const d = this.track.deltaS(a, b);
    return ds > 0 ? d > 0 && d <= ds : d <= 0 && d > ds;
  }

  /**
   * @returns 'lap' when a lap was completed, 'finish' when the race was completed, or null.
   */
  update(x: number, z: number, headingX: number, headingZ: number, speed: number, raceTime: number, dt: number): 'lap' | 'finish' | null {
    const t = this.track;
    t.project(x, z, this.proj.index, this.proj);
    const s = this.proj.s;
    let result: 'lap' | 'finish' | null = null;

    if (this.proj.distance > t.halfWidth + 1.5) this.offTrackTime += dt;
    else this.offTrackTime = 0;

    if (this.prevS >= 0 && !this.finished) {
      const ds = t.deltaS(this.prevS, s);
      const nearTrack = this.proj.distance < t.def.barrierOffset + 6;
      if (ds !== 0 && nearTrack) {
        if (ds > 0) {
          if (this.nextCheckpoint < this.boundaries.length && this.crossed(this.prevS, ds, this.boundaries[this.nextCheckpoint])) {
            this.nextCheckpoint++;
          }
          if (this.nextCheckpoint === this.boundaries.length && this.crossed(this.prevS, ds, 0)) {
            // Crossed the finish line having visited every checkpoint.
            if (this.lapsCompleted >= 0) {
              const lapTime = raceTime - this.lapStartTime;
              this.lastLapTime = lapTime;
              this.lapTimes.push(lapTime);
              if (lapTime < this.bestLapTime) this.bestLapTime = lapTime;
              this.lapStartTime = raceTime;
            }
            this.lapsCompleted++;
            this.nextCheckpoint = 0;
            if (this.lapsCompleted >= this.totalLaps) {
              this.finished = true;
              this.finishTime = raceTime;
              result = 'finish';
            } else if (this.lapsCompleted > 0) {
              result = 'lap';
            }
          }
        } else {
          // Reversing: undo checkpoints so driving backwards over the line can't be exploited.
          if (this.nextCheckpoint === 0 && this.crossed(this.prevS, ds, 0)) {
            this.lapsCompleted--;
            this.nextCheckpoint = this.boundaries.length;
          } else if (this.nextCheckpoint > 0 && this.nextCheckpoint <= this.boundaries.length) {
            const b = this.boundaries[this.nextCheckpoint - 1];
            if (this.crossed(this.prevS, ds, b)) this.nextCheckpoint--;
          }
        }
      }
    }
    this.prevS = s;

    // Wrong-way detection
    const tan = t.tan;
    const i = this.proj.index;
    const dot = headingX * tan[i * 3] + headingZ * tan[i * 3 + 2];
    if (dot < -0.35 && speed > 3) this.wrongWayTimer += dt;
    else this.wrongWayTimer = Math.max(0, this.wrongWayTimer - dt * 2);
    this.wrongWay = this.wrongWayTimer > 1.2;
    return result;
  }

  /** Called after teleporting the car so we don't register a bogus jump. */
  resync(x: number, z: number): void {
    this.track.project(x, z, -1, this.proj);
    this.prevS = this.proj.s;
  }
}
