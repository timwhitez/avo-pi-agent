"use client";

const COLORS = [
  "#0f172a", "#2563eb", "#ef4444", "#22c55e", "#eab308",
  "#94a3b8", "#f472b6", "#fb923c", "#38bdf8", "#a855f7",
  "#f8fafc", "#14b8a6", "#f43f5e", "#84cc16", "#6366f1", "#d946ef",
];

export function ArcGrid({ grid }: { grid: number[][] | null }) {
  if (!grid?.length || !grid[0]?.length) {
    return <div className="empty-grid">No exact frame is available yet.</div>;
  }
  const width = Math.max(...grid.map((row) => row.length));
  const cell = Math.max(5, Math.min(22, Math.floor(560 / Math.max(width, grid.length))));
  return (
    <div className="grid-shell" aria-label={`${width} by ${grid.length} ARC grid`}>
      <div
        className="arc-grid"
        style={{ gridTemplateColumns: `repeat(${width}, ${cell}px)` }}
        role="img"
      >
        {grid.flatMap((row, y) => Array.from({ length: width }, (_, x) => {
          const value = Number(row[x] ?? 0);
          return (
            <span
              key={`${x}-${y}`}
              className="arc-cell"
              style={{ width: cell, height: cell, background: COLORS[Math.abs(value) % COLORS.length] }}
              title={`x=${x}, y=${y}, value=${value}`}
            />
          );
        }))}
      </div>
    </div>
  );
}
