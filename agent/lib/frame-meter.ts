// Lightweight, process-local frame meter. It observes EGL presentation only;
// it never changes rendering state and owns one detachable listener.

export interface FrameMeterState {
  running: boolean;
  source: string | null;
  address: string | null;
  frames: number;
  elapsedMs: number;
  fps: number;
  /** Alias consumed by host verification receipts. */
  fired: number;
  verified: boolean;
  state: "verified" | "unverified";
}

export class FrameMeter {
  private listener: InvocationListener | null = null;
  private source: string | null = null;
  private address: NativePointer | null = null;
  private frames = 0;
  private startedAt = 0;
  private stoppedAt = 0;

  start(): FrameMeterState {
    if (this.listener) return this.status();
    const candidates = ["eglSwapBuffers", "eglSwapBuffersWithDamageKHR"];
    for (const name of candidates) {
      const address = Module.findGlobalExportByName(name);
      if (!address) continue;
      this.source = name;
      this.address = address;
      this.frames = 0;
      this.startedAt = Date.now();
      this.stoppedAt = 0;
      this.listener = Interceptor.attach(address, {
        onEnter: () => { this.frames += 1; },
      });
      return this.status();
    }
    throw new Error("No EGL presentation export is loaded; this game may be using Vulkan");
  }

  status(): FrameMeterState {
    const end = this.listener ? Date.now() : this.stoppedAt;
    const elapsedMs = this.startedAt > 0 ? Math.max(0, end - this.startedAt) : 0;
    const fps = elapsedMs > 0 ? Math.round((this.frames * 100000) / elapsedMs) / 100 : 0;
    return {
      running: this.listener !== null,
      source: this.source,
      address: this.address?.toString() ?? null,
      frames: this.frames,
      elapsedMs,
      fps,
      fired: this.frames,
      verified: this.frames > 0,
      state: this.frames > 0 ? "verified" : "unverified",
    };
  }

  stop(): FrameMeterState {
    if (this.listener) {
      this.stoppedAt = Date.now();
      this.listener.detach();
      this.listener = null;
    }
    return this.status();
  }

  reset(): FrameMeterState {
    this.stop();
    this.source = null;
    this.address = null;
    this.frames = 0;
    this.startedAt = 0;
    this.stoppedAt = 0;
    return this.status();
  }
}
