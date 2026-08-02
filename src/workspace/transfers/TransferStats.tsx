import type { WorkspaceTransfer } from "../types";
import type { TransferUiCopy } from "./copy";
import { formatBytes, isToday } from "./format";

const ACTIVE_STATES = new Set(["queued", "running", "pausing", "paused", "waiting-conflict", "verifying", "finalizing"]);
const ATTENTION_STATES = new Set(["failed", "cancelled", "interrupted"]);

export function TransferStats({ copy, transfers }: { copy: TransferUiCopy; transfers: WorkspaceTransfer[] }) {
  const today = transfers.filter((transfer) => isToday(transfer.createdAt));
  const active = transfers.filter((transfer) => ACTIVE_STATES.has(transfer.state));
  const completed = transfers.filter((transfer) => transfer.state === "completed");
  const failed = transfers.filter((transfer) => ATTENTION_STATES.has(transfer.state));
  const throughput = active.reduce((sum, transfer) => sum + Number(transfer.speedBytesPerSecond ?? 0), 0);
  const todayBytes = today.reduce((sum, transfer) => sum + Number(transfer.bytes), 0);
  const successRate = transfers.length === 0 ? 0 : (completed.length / transfers.length) * 100;
  const averageSpeed = active.length === 0 ? 0 : throughput / active.length;

  const stats = [
    { key: "today", icon: "⇅", label: copy.today, value: String(today.length), meta: `${formatBytes(String(todayBytes))} ${copy.transferred}` },
    { key: "active", icon: "▶", label: copy.active, value: String(active.length), meta: `${copy.averageSpeed} ${formatBytes(String(averageSpeed))}/s` },
    { key: "completed", icon: "✓", label: copy.completed, value: String(completed.length), meta: `${copy.successRate} ${successRate.toFixed(1)}%` },
    { key: "failed", icon: "×", label: copy.failed, value: String(failed.length), meta: `${failed.length} ${copy.needsAttention}` },
    { key: "throughput", icon: "⌁", label: copy.throughput, value: `${formatBytes(String(throughput))}/s`, meta: copy.liveAggregate }
  ];

  return (
    <section className="transferStats" aria-label={copy.title}>
      {stats.map((stat) => (
        <article className="transferStatCard" data-tone={stat.key} key={stat.key}>
          <span className="transferStatIcon" aria-hidden="true">{stat.icon}</span>
          <div>
            <span className="transferStatLabel">{stat.label}</span>
            <strong>{stat.value}</strong>
            <small>{stat.meta}</small>
          </div>
        </article>
      ))}
    </section>
  );
}
