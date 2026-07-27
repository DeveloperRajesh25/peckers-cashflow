 // Hour × weekday heat map, shared by the Orders / Net Sales / AOV grids. The
// 7-day data cells are shaded on a smooth red→yellow→green gradient (Excel's
// default 3-colour scale) so busy and quiet windows read at a glance. The Total
// column and Total row are left uncoloured (neutral) — they sit on a larger
// scale and the heat shading is only meaningful for the individual hour×day cells.
//
// `formatValue` and `legendLabel` let the same grid render counts or money.
//
// Only ever render totals and counts here, never ratios: an AOV grid at this
// grain was tried and dropped (Update 34) because ~10 orders per cell left the
// colours dominated by sampling noise.

// Dark ink stays readable across every shade of the gradient.
const CELL_TEXT = "#333";

// Gradient anchor stops: t=0 red, t=0.5 yellow, t=1 green.
const STOP_LOW: [number, number, number] = [0xf8, 0x69, 0x6b];
const STOP_MID: [number, number, number] = [0xff, 0xeb, 0x84];
const STOP_HIGH: [number, number, number] = [0x63, 0xbe, 0x7b];

const GRADIENT_CSS = "linear-gradient(to right, #f8696b, #ffeb84, #63be7b)";

const lerp = (a: number, b: number, u: number) => Math.round(a + (b - a) * u);

function mix(
  from: [number, number, number],
  to: [number, number, number],
  u: number,
): string {
  return `rgb(${lerp(from[0], to[0], u)}, ${lerp(from[1], to[1], u)}, ${lerp(from[2], to[2], u)})`;
}

// Interpolate a cell's fill along red→yellow→green by its position in the value
// range. When every value is equal (max === min) there's no spread to rank, so
// sit in the middle (yellow) instead of dividing by zero.
function heatColor(value: number, min: number, max: number): string {
  const t = max > min ? Math.min(1, Math.max(0, (value - min) / (max - min))) : 0.5;
  return t < 0.5
    ? mix(STOP_LOW, STOP_MID, t / 0.5)
    : mix(STOP_MID, STOP_HIGH, (t - 0.5) / 0.5);
}

export interface HeatmapData {
  hours: number[];
  days: string[];
  cells: number[][];
  rowTotals: number[];
  colTotals: number[];
  grandTotal: number;
}

const hhmm = (h: number) => `${String(h).padStart(2, "0")}:00`;

const heatCell = "px-3 py-2 text-center tabular-nums font-medium";

export function HourDayHeatmap({
  data,
  formatValue = (v: number) => String(v),
  legendLabel = "orders / hour",
}: {
  data: HeatmapData;
  formatValue?: (v: number) => string;
  legendLabel?: string;
}) {
  const { hours, days, cells, rowTotals, colTotals, grandTotal } = data;

  if (hours.length === 0) {
    return (
      <div className="vm-table-container px-4 py-8 text-center text-tertiary">
        No hourly activity for this week.
      </div>
    );
  }

  const flat = cells.flat();
  const cellMin = Math.min(...flat);
  const cellMax = Math.max(...flat);

  return (
    <div className="space-y-3">
      <div className="vm-table-container">
        <div className="table-scroll overflow-x-auto">
          <table className="vm-table text-sm">
            <thead>
              <tr className="bg-surface-hover text-secondary">
                <th className="whitespace-nowrap px-3 py-3 text-left font-semibold uppercase text-xs tracking-wide border-b border-line">
                  Hour
                </th>
                {days.map((d) => (
                  <th
                    key={d}
                    className="whitespace-nowrap px-3 py-3 text-center font-semibold uppercase text-xs tracking-wide border-b border-l border-line"
                  >
                    {d.slice(0, 3)}
                  </th>
                ))}
                <th className="whitespace-nowrap px-3 py-3 text-center font-semibold uppercase text-xs tracking-wide border-b border-l border-line">
                  Total
                </th>
              </tr>
            </thead>
            <tbody>
              {hours.map((h, ri) => (
                <tr key={h}>
                  <td className="whitespace-nowrap px-3 py-2 text-left font-medium text-primary">
                    {hhmm(h)}
                  </td>
                  {cells[ri].map((v, ci) => (
                    <td
                      key={ci}
                      className={`${heatCell} border-l border-line`}
                      style={{ backgroundColor: heatColor(v, cellMin, cellMax), color: CELL_TEXT }}
                    >
                      {formatValue(v)}
                    </td>
                  ))}
                  <td className={`${heatCell} font-bold text-primary border-l border-line`}>
                    {formatValue(rowTotals[ri])}
                  </td>
                </tr>
              ))}
              <tr>
                <td className="whitespace-nowrap px-3 py-2 text-left font-bold text-primary border-t border-line">
                  Total
                </td>
                {colTotals.map((v, ci) => (
                  <td
                    key={ci}
                    className={`${heatCell} font-bold text-primary border-t border-l border-line`}
                  >
                    {formatValue(v)}
                  </td>
                ))}
                <td className={`${heatCell} font-bold text-primary border-t border-l border-line`}>
                  {formatValue(grandTotal)}
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>

      <div className="flex items-center gap-2 text-xs text-secondary">
        <span className="tabular-nums">{formatValue(cellMin)}</span>
        <span
          className="h-3 w-40 rounded-sm border border-line"
          style={{ background: GRADIENT_CSS }}
        />
        <span className="tabular-nums">{formatValue(cellMax)}</span>
        <span className="ml-1">{legendLabel}</span>
      </div>
    </div>
  );
}
