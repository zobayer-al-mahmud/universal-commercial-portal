import "server-only";
import os from "os";
import { statfs } from "fs/promises";
import { readFile } from "fs/promises";
import { env } from "@/lib/env";

/**
 * Real server metrics for the Super Admin Control Center (Server Monitoring).
 * Sourced from Node's `os` + the filesystem + /proc on Linux — no external deps,
 * no mock data. Every probe is guarded so a single unsupported metric (e.g. on a
 * non-Linux dev box) degrades to null instead of failing the whole snapshot.
 * Lightweight by design (a ~200 ms CPU sample) so it never slows UCP processing.
 */

export interface SystemMetrics {
  hostname: string;
  platform: string;
  uptimeSec: number; // OS uptime
  processUptimeSec: number; // this Node process
  cpu: {
    cores: number;
    model: string;
    loadAvg1: number;
    loadAvg5: number;
    loadAvg15: number;
    usagePct: number | null; // sampled over ~200ms
  };
  memory: {
    totalBytes: number;
    freeBytes: number;
    usedBytes: number;
    usedPct: number;
    processRssBytes: number;
  };
  disk: { path: string; totalBytes: number; freeBytes: number; usedBytes: number; usedPct: number } | null;
  network: { iface: string; rxBytes: number; txBytes: number }[] | null;
  at: string;
}

function cpuTimes() {
  const cpus = os.cpus();
  let idle = 0;
  let total = 0;
  for (const c of cpus) {
    idle += c.times.idle;
    total += c.times.user + c.times.nice + c.times.sys + c.times.idle + c.times.irq;
  }
  return { idle, total };
}

/** Sample CPU usage over a short window. Returns 0..100 or null if unavailable. */
async function sampleCpuPct(ms = 200): Promise<number | null> {
  try {
    const a = cpuTimes();
    await new Promise((r) => setTimeout(r, ms));
    const b = cpuTimes();
    const idleDelta = b.idle - a.idle;
    const totalDelta = b.total - a.total;
    if (totalDelta <= 0) return null;
    return Math.max(0, Math.min(100, Math.round((1 - idleDelta / totalDelta) * 100)));
  } catch {
    return null;
  }
}

async function diskFor(path: string) {
  try {
    const s = await statfs(path);
    const total = s.blocks * s.bsize;
    const free = s.bfree * s.bsize;
    const used = total - free;
    return { path, totalBytes: total, freeBytes: free, usedBytes: used, usedPct: total > 0 ? Math.round((used / total) * 100) : 0 };
  } catch {
    return null;
  }
}

/** Parse /proc/net/dev on Linux for per-interface rx/tx bytes (cumulative). */
async function networkStats() {
  try {
    const txt = await readFile("/proc/net/dev", "utf8");
    const out: { iface: string; rxBytes: number; txBytes: number }[] = [];
    for (const line of txt.split("\n")) {
      const m = line.match(/^\s*([^:]+):\s*(.*)$/);
      if (!m) continue;
      const iface = m[1]!.trim();
      if (iface === "lo") continue;
      const cols = m[2]!.trim().split(/\s+/).map(Number);
      if (cols.length < 9) continue;
      out.push({ iface, rxBytes: cols[0]!, txBytes: cols[8]! });
    }
    return out.length ? out : null;
  } catch {
    return null;
  }
}

export async function getSystemMetrics(): Promise<SystemMetrics> {
  const [usagePct, disk, network] = await Promise.all([
    sampleCpuPct(),
    diskFor(env.STORAGE_ROOT || "/"),
    networkStats(),
  ]);
  const totalMem = os.totalmem();
  const freeMem = os.freemem();
  const load = os.loadavg();
  const cpus = os.cpus();
  return {
    hostname: os.hostname(),
    platform: `${os.type()} ${os.release()}`,
    uptimeSec: Math.round(os.uptime()),
    processUptimeSec: Math.round(process.uptime()),
    cpu: {
      cores: cpus.length,
      model: cpus[0]?.model?.trim() ?? "",
      loadAvg1: Number(load[0]?.toFixed(2) ?? 0),
      loadAvg5: Number(load[1]?.toFixed(2) ?? 0),
      loadAvg15: Number(load[2]?.toFixed(2) ?? 0),
      usagePct,
    },
    memory: {
      totalBytes: totalMem,
      freeBytes: freeMem,
      usedBytes: totalMem - freeMem,
      usedPct: totalMem > 0 ? Math.round(((totalMem - freeMem) / totalMem) * 100) : 0,
      processRssBytes: process.memoryUsage().rss,
    },
    disk,
    network,
    at: new Date().toISOString(),
  };
}
