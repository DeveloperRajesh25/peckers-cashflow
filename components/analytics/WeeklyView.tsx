"use client";

import * as React from "react";
import { Card, CardHeader, CardTitle, CardDescription } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";
import { Skeleton } from "@/components/ui/Skeleton";
import { EmptyState } from "@/components/ui/EmptyState";
import { ChartIcon, ChevronLeftIcon, ChevronRightIcon } from "@/components/ui/icons";
import { createClient } from "@/lib/supabase";
import { StatTile } from "./StatTile";
import { useChartColors } from "./useChartColors";
import {
  addDays,
  eachDay,
  endOfISOWeek,
  formatDDMMYYYY,
  formatHoursMins,
  formatINR,
  isSameDay,
  startOfISOWeek,
  toISODate,
  WEEKDAY_SHORT,
  weekLabel,
} from "@/lib/utils";
import {
  Bar,
  BarChart,
  CartesianGrid,
  Legend,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

type DailyRow = {
  date: string;
  day: string;
  sales: number;
  expenses: number;
};

type EmpPay = {
  employee_id: string;
  employee_name: string;
  cash_hours: number;
  cash_amount_due: number;
  total_hours_worked: number;
};

export function WeeklyView({
  storeId,
  employeeIds,
}: {
  storeId: string;
  employeeIds: string[];
}) {
  const supabase = React.useMemo(() => createClient(), []);
  const colors = useChartColors();
  const [weekStart, setWeekStart] = React.useState<Date>(startOfISOWeek(new Date()));
  const [loading, setLoading] = React.useState(true);
  const [daily, setDaily] = React.useState<DailyRow[]>([]);
  const [empPay, setEmpPay] = React.useState<EmpPay[]>([]);
  const [coverPay, setCoverPay] = React.useState<Array<{ total_pay: number }>>([]);

  const weekEnd = React.useMemo(() => endOfISOWeek(weekStart), [weekStart]);
  // Stable key so the effect re-runs when the store's employee set changes.
  const empKey = employeeIds.join(",");

  const totals = React.useMemo(() => {
    const sales = daily.reduce((s, r) => s + r.sales, 0);
    const exp = daily.reduce((s, r) => s + r.expenses, 0);
    const empCash = empPay.reduce((s, r) => s + Number(r.cash_amount_due || 0), 0);
    // Cover drivers are cash-only and paid from the same till, so leaving them
    // out made a weekend look cheaper than it was.
    const coverCash = coverPay.reduce((s, r) => s + Number(r.total_pay || 0), 0);
    return {
      sales,
      exp,
      empCash,
      coverCash,
      cashPay: empCash + coverCash,
      net: sales - exp - empCash - coverCash,
    };
  }, [daily, empPay, coverPay]);

  React.useEffect(() => {
    let active = true;
    async function load() {
      setLoading(true);
      try {
        const startISO = toISODate(weekStart);
        const endISO = toISODate(weekEnd);

        const [entries, hours, coverHours] = await Promise.all([
          supabase
            .from("daily_cash_entries")
            .select("entry_date, vita_mojo_sales, supermarket_expenses")
            .eq("store_id", storeId)
            .gte("entry_date", startISO)
            .lte("entry_date", endISO),
          supabase
            .from("employee_hours_computed")
            .select(
              "employee_id, employee_name, cash_hours, cash_amount_due, total_hours_worked, week_start_date",
            )
            .eq("week_start_date", startISO)
            .in("employee_id", employeeIds.length ? employeeIds : ["00000000-0000-0000-0000-000000000000"]),
          // Cover drivers are keyed per DAY, not per week, and only approved
          // days represent money actually owed.
          supabase
            .from("cover_driver_hours_computed")
            .select("total_pay")
            .eq("store_id", storeId)
            .eq("approved", true)
            .gte("work_date", startISO)
            .lte("work_date", endISO),
        ]);

        if (!active) return;

        const days = eachDay(weekStart, weekEnd).map((d, i): DailyRow => ({
          date: toISODate(d),
          day: WEEKDAY_SHORT[i],
          sales: 0,
          expenses: 0,
        }));

        for (const e of entries.data ?? []) {
          const idx = days.findIndex((x) => x.date === e.entry_date);
          if (idx >= 0) {
            days[idx].sales += Number(e.vita_mojo_sales || 0);
            days[idx].expenses += Number(e.supermarket_expenses || 0);
          }
        }
        setDaily(days);
        setEmpPay((hours.data ?? []) as unknown as EmpPay[]);
        setCoverPay((coverHours.data ?? []) as unknown as Array<{ total_pay: number }>);
      } finally {
        if (active) setLoading(false);
      }
    }
    load();
    return () => {
      active = false;
    };
  }, [supabase, weekStart, weekEnd, storeId, empKey]);

  const isCurrent = isSameDay(weekStart, startOfISOWeek(new Date()));

  return (
    <div className="flex flex-col gap-5">
      <Card>
        <div className="flex items-center justify-between gap-3 flex-wrap">
          <div>
            <p className="text-xs uppercase tracking-[0.18em] text-text-muted font-medium">
              Selected Week
            </p>
            <p className="text-lg font-semibold mt-1">{weekLabel(weekStart)}</p>
          </div>
          <div className="flex items-center gap-2">
            <Button
              variant="secondary"
              size="icon"
              onClick={() => setWeekStart((d) => addDays(d, -7))}
              aria-label="Previous week"
            >
              <ChevronLeftIcon />
            </Button>
            <Button
              variant="secondary"
              size="sm"
              onClick={() => setWeekStart(startOfISOWeek(new Date()))}
              disabled={isCurrent}
            >
              This week
            </Button>
            <Button
              variant="secondary"
              size="icon"
              onClick={() => setWeekStart((d) => addDays(d, 7))}
              aria-label="Next week"
            >
              <ChevronRightIcon />
            </Button>
          </div>
        </div>
      </Card>

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 sm:gap-4">
        {loading ? (
          <>
            <Skeleton className="h-[110px]" />
            <Skeleton className="h-[110px]" />
            <Skeleton className="h-[110px]" />
            <Skeleton className="h-[110px]" />
          </>
        ) : (
          <>
            <StatTile label="Total Sales" value={totals.sales} tone="gold" />
            <StatTile label="Total Expenses" value={totals.exp} />
            <StatTile
              label={totals.coverCash > 0 ? "Cash Pay (incl. cover)" : "Employee Cash Pay"}
              value={totals.cashPay}
              tone="danger"
            />
            <StatTile
              label="Net Cash Flow"
              value={totals.net}
              tone={totals.net >= 0 ? "success" : "danger"}
            />
          </>
        )}
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Daily Sales vs Expenses</CardTitle>
          <CardDescription>Bars in £</CardDescription>
        </CardHeader>

        {loading ? (
          <Skeleton className="h-[280px]" />
        ) : daily.every((d) => d.sales === 0 && d.expenses === 0) ? (
          <EmptyState
            icon={<ChartIcon />}
            title="No data this week"
            description="Once cash entries are logged, you'll see daily totals here."
          />
        ) : (
          <div className="h-[280px]">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={daily} margin={{ top: 10, right: 10, left: 0, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" vertical={false} />
                <XAxis dataKey="day" tick={{ fontSize: 12 }} />
                <YAxis
                  tick={{ fontSize: 12 }}
                  tickFormatter={(v) => `£${v}`}
                  width={70}
                />
                <Tooltip
                  formatter={(v: number) => formatINR(v)}
                  cursor={{ fill: colors.cursorFill }}
                />
                <Legend />
                <Bar dataKey="sales" name="Sales" fill={colors.gold} radius={[6, 6, 0, 0]} />
                <Bar dataKey="expenses" name="Expenses" fill={colors.danger} radius={[6, 6, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        )}
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Employee Cash Payments</CardTitle>
          <CardDescription>
            Hours over 20/week paid in cash · for week of {formatDDMMYYYY(weekStart)}
          </CardDescription>
        </CardHeader>

        {loading ? (
          <Skeleton className="h-[120px]" />
        ) : empPay.length === 0 || empPay.every((p) => Number(p.cash_amount_due) === 0) ? (
          <EmptyState
            icon={<ChartIcon />}
            title="No cash payments due"
            description="No employee has logged more than 20 hours this week yet."
          />
        ) : (
          <div className="overflow-x-auto -mx-1">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-xs uppercase tracking-wider text-text-muted">
                  <th className="px-3 py-2 font-medium">Employee</th>
                  <th className="px-3 py-2 font-medium text-right">Total hrs</th>
                  <th className="px-3 py-2 font-medium text-right">Cash hrs</th>
                  <th className="px-3 py-2 font-medium text-right">Cash due</th>
                </tr>
              </thead>
              <tbody>
                {empPay
                  .filter((p) => Number(p.cash_amount_due) > 0)
                  .map((p, i) => (
                    <tr
                      key={p.employee_id}
                      className={`${i % 2 === 0 ? "" : "bg-bg/50"} border-t border-border/60`}
                    >
                      <td className="px-3 py-3">{p.employee_name}</td>
                      <td className="px-3 py-3 text-right tabular-nums">
                        {formatHoursMins(Number(p.total_hours_worked))}
                      </td>
                      <td className="px-3 py-3 text-right tabular-nums">
                        {formatHoursMins(Number(p.cash_hours))}
                      </td>
                      <td className="px-3 py-3 text-right tabular-nums font-medium text-gold">
                        {formatINR(Number(p.cash_amount_due))}
                      </td>
                    </tr>
                  ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
}
