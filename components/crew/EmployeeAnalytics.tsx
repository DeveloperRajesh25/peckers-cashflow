// =============================================================
// "My Analytics" — an employee's own hours, deliveries and earnings.
//
// Built mobile-first: crew open this on a phone, so every grid starts at one or
// two columns, nothing scrolls sideways, and the numbers people actually came
// for (this week's pay, this month's pay) sit at the very top before any chart.
//
// Server-rendered and chart-library-free on purpose: the bars are plain divs,
// so they inherit the theme tokens (light/dark) for free, add nothing to the
// mobile bundle, and stay readable on a 360px screen.
//
// Each panel carries its own AnalyticsRangePicker and its own URL param, so
// moving one window leaves the others where the employee left them.
//
// Every figure is priced by lib/employee-analytics, which uses the payout's own
// rules — so this page can never disagree with the Tuesday envelope.
// =============================================================

import { Card, CardDescription, CardHeader, CardTitle } from "@/components/ui/Card";
import { Badge } from "@/components/ui/Badge";
import { AnalyticsRangePicker } from "@/components/crew/AnalyticsRangePicker";
import { cn, formatGBP, formatHoursMinsWords } from "@/lib/utils";
import {
  DELIVERY_WEEK_OPTIONS,
  MONTHS_IN_CHART,
  PATTERN_WEEKS,
  WEEKS_IN_CHART,
} from "@/lib/employee-analytics";
import type {
  Bucket,
  EmployeeAnalytics as Analytics,
  RangeInfo,
  Totals,
} from "@/lib/employee-analytics";

function hoursText(h: number) {
  return formatHoursMinsWords(h);
}

function StatCard({
  label,
  value,
  sub,
}: {
  label: string;
  value: string;
  sub?: string;
}) {
  return (
    <Card className="p-4">
      <p className="text-[11px] uppercase tracking-[0.12em] text-text-muted">{label}</p>
      <p className="text-xl sm:text-2xl font-semibold text-text-primary mt-1.5 tabular-nums">
        {value}
      </p>
      {sub && <p className="text-xs text-text-muted mt-1">{sub}</p>}
    </Card>
  );
}

/** One line of a breakdown: label on the left, amount right-aligned. */
function Row({
  label,
  value,
  sub,
  strong = false,
}: {
  label: string;
  value: string;
  sub?: string;
  strong?: boolean;
}) {
  return (
    <div className="flex items-center justify-between gap-3 py-2.5 border-b border-border last:border-0">
      <div className="min-w-0">
        <p
          className={cn(
            "text-sm truncate",
            strong ? "text-text-primary font-medium" : "text-text-muted",
          )}
        >
          {label}
        </p>
        {sub && <p className="text-[11px] text-text-muted mt-0.5">{sub}</p>}
      </div>
      <span
        className={cn(
          "text-sm tabular-nums shrink-0",
          strong ? "font-semibold text-text-primary" : "font-medium text-text-primary",
        )}
      >
        {value}
      </span>
    </div>
  );
}

/**
 * Vertical bars sized as a percentage of the tallest bucket. A bucket with a
 * value never renders shorter than 4% so a quiet week is still visibly a bar;
 * an empty one renders as a flat rule, which reads as "nothing" rather than as
 * a broken chart.
 */
function BarChart({
  data,
  value,
  format,
  heading,
}: {
  data: Bucket[];
  value: (b: Bucket) => number;
  format: (n: number) => string;
  heading: string;
}) {
  const max = data.reduce((m, d) => Math.max(m, value(d)), 0);
  // Value labels fit while the buckets are few; a 12-week span on a phone is
  // the case that doesn't, so they drop to `sm` and up beyond eight bars.
  const showValues = data.length <= 8;

  return (
    <div>
      <p className="text-[11px] uppercase tracking-[0.12em] text-text-muted mb-2">
        {heading}
      </p>
      <div className="flex items-end gap-1.5 h-32 sm:h-40">
        {data.map((d) => {
          const v = value(d);
          const pct = max > 0 && v > 0 ? Math.max((v / max) * 100, 4) : 0;
          return (
            <div
              key={d.key}
              className="flex-1 min-w-0 h-full flex flex-col justify-end items-center gap-1"
              title={`${d.label}: ${format(v)}`}
            >
              <span
                className={cn(
                  "text-[10px] leading-none text-text-subtle tabular-nums",
                  showValues ? "block" : "hidden sm:block",
                )}
              >
                {v > 0 ? format(v) : ""}
              </span>
              {v > 0 ? (
                <div
                  className={cn(
                    "w-full rounded-t-md",
                    d.isCurrent ? "bg-gold" : "bg-gold/45",
                  )}
                  style={{ height: `${pct}%` }}
                />
              ) : (
                <div className="w-full h-[2px] rounded bg-border" />
              )}
            </div>
          );
        })}
      </div>
      <div className="flex gap-1.5 mt-2 pt-2 border-t border-border">
        {data.map((d) => (
          <div
            key={d.key}
            className={cn(
              "flex-1 min-w-0 text-center text-[9px] sm:text-[10px] truncate",
              d.isCurrent ? "text-text-primary font-medium" : "text-text-muted",
            )}
          >
            {d.label}
          </div>
        ))}
      </div>
    </div>
  );
}

/** A panel heading with its date control underneath — the pattern every
 *  selectable section on this page uses. */
function PanelHeader({
  title,
  description,
  range,
  param,
  unit,
  span,
}: {
  title: string;
  description: string;
  range: RangeInfo;
  param: string;
  unit: "week" | "month";
  span?: { param: string; value: number; options: number[] };
}) {
  return (
    <div className="mb-4">
      <CardTitle>{title}</CardTitle>
      <CardDescription>{description}</CardDescription>
      <div className="mt-3">
        <AnalyticsRangePicker
          param={param}
          unit={unit}
          anchor={range.anchor}
          minAnchor={range.minAnchor}
          maxAnchor={range.maxAnchor}
          label={range.label}
          span={span}
        />
      </div>
    </div>
  );
}

/**
 * A week's drops, spelled out. The miscellaneous drops are listed separately
 * rather than folded into the short/long counts — they are a different thing to
 * the driver (an extra drop beyond the round) even though they pay the same
 * per-type rate, and the totals below break them out the same way.
 */
function dropBreakdown(t: Totals) {
  const parts: string[] = [];
  if (t.sd > 0) parts.push(`${t.sd} short`);
  if (t.ld > 0) parts.push(`${t.ld} long`);
  if (t.sm > 0) parts.push(`${t.sm} misc short`);
  if (t.lm > 0) parts.push(`${t.lm} misc long`);
  return parts.join(" · ");
}

/** A period's detail line: hours, and drops for a driver. Kept short — it sits
 *  under a value in a half-width card on a phone. */
function periodSummary(t: Totals, isDriver: boolean) {
  const parts = [hoursText(t.hours)];
  if (isDriver && t.deliveries > 0) parts.push(`${t.deliveries} drops`);
  return parts.join(" · ");
}

export function EmployeeAnalyticsView({
  data,
  loadError = null,
}: {
  data: Analytics;
  loadError?: string | null;
}) {
  if (loadError) {
    return (
      <Card className="border-danger/40">
        <p className="text-sm text-danger">{loadError}</p>
      </Card>
    );
  }

  if (data.isEmpty) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Nothing to show yet</CardTitle>
          <CardDescription>
            Your hours and earnings appear here once you&apos;ve clocked out of
            your first shift. A shift you&apos;re part-way through isn&apos;t
            counted until you clock out.
          </CardDescription>
        </CardHeader>
      </Card>
    );
  }

  const { rates, thisWeek, lastWeek, thisMonth, lastMonth, pattern } = data;
  const showMoney = rates.hasRates;
  const isDriver = rates.isDriver;
  const payDelta = thisWeek.totalPay - lastWeek.totalPay;
  const hoursDelta = thisWeek.hours - lastWeek.hours;
  const maxWeekdayHours = data.weekdays.reduce((m, w) => Math.max(m, w.hours), 0);
  const recentWeeks = [...data.weeks].reverse();
  const deliveryWeeksNewestFirst = [...data.deliveryWeeks].reverse();

  return (
    <div className="flex flex-col gap-4 sm:gap-5">
      {/* ---- Hero: the number people open the app for ---- */}
      <Card className="p-5 border-gold/30">
        <p className="text-[11px] uppercase tracking-[0.14em] text-text-muted">
          {showMoney ? "Earned this week" : "Worked this week"}
        </p>
        <p className="text-4xl sm:text-5xl font-semibold text-text-primary mt-1 tabular-nums">
          {showMoney ? formatGBP(thisWeek.totalPay) : hoursText(thisWeek.hours)}
        </p>
        <p className="text-sm text-text-muted mt-1.5">
          {periodSummary(thisWeek, isDriver)}
          {thisWeek.daysWorked > 0 &&
            ` · ${thisWeek.daysWorked} day${thisWeek.daysWorked === 1 ? "" : "s"}`}
        </p>
        <div className="flex flex-wrap items-center gap-2 mt-3">
          {showMoney && (
            <Badge variant={payDelta >= 0 ? "success" : "neutral"}>
              {payDelta >= 0 ? "+" : "−"}
              {formatGBP(Math.abs(payDelta))} vs last week
            </Badge>
          )}
          <Badge variant={hoursDelta >= 0 ? "success" : "neutral"}>
            {hoursDelta >= 0 ? "+" : "−"}
            {formatHoursMinsWords(Math.abs(hoursDelta))} vs last week
          </Badge>
        </div>
        <p className="text-[11px] text-text-muted mt-3">
          Still adding up — this week isn&apos;t finished, and a shift counts once
          you clock out.
        </p>
      </Card>

      {/* ---- Quick stats. Two columns on a phone, four on a laptop. ---- */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <StatCard
          label="Last week"
          value={showMoney ? formatGBP(lastWeek.totalPay) : hoursText(lastWeek.hours)}
          sub={periodSummary(lastWeek, isDriver)}
        />
        <StatCard
          label="This month"
          value={showMoney ? formatGBP(thisMonth.totalPay) : hoursText(thisMonth.hours)}
          sub={periodSummary(thisMonth, isDriver)}
        />
        <StatCard
          label="Last month"
          value={showMoney ? formatGBP(lastMonth.totalPay) : hoursText(lastMonth.hours)}
          sub={periodSummary(lastMonth, isDriver)}
        />
        <StatCard
          label={data.monthsRange.label}
          value={
            showMoney
              ? formatGBP(data.monthsTotal.totalPay)
              : hoursText(data.monthsTotal.hours)
          }
          sub={periodSummary(data.monthsTotal, isDriver)}
        />
      </div>

      {/* ---- Week by week ---- */}
      <Card className="p-4 sm:p-5">
        <PanelHeader
          title="Week by week"
          description={`${WEEKS_IN_CHART} weeks. Use the calendar to look at any other ${WEEKS_IN_CHART}.`}
          range={data.weeksRange}
          param="w"
          unit="week"
        />
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          {showMoney && (
            <BarChart
              heading="Earnings"
              data={data.weeks}
              value={(b) => b.totalPay}
              format={(n) => formatGBP(n, { compact: true })}
            />
          )}
          <BarChart
            heading="Hours"
            data={data.weeks}
            value={(b) => b.hours}
            format={(n) => formatHoursMinsWords(n)}
          />
        </div>
        <div className="mt-5 pt-4 border-t border-border">
          <p className="text-[11px] uppercase tracking-[0.12em] text-text-muted mb-1">
            These weeks
          </p>
          {recentWeeks.map((w) => (
            <Row
              key={w.key}
              label={`Week of ${w.label}`}
              sub={
                w.hours > 0 || w.deliveries > 0
                  ? periodSummary(w, isDriver)
                  : "No shifts"
              }
              value={showMoney ? formatGBP(w.totalPay) : hoursText(w.hours)}
              strong={w.isCurrent}
            />
          ))}
        </div>
      </Card>

      {/* ---- Month by month ---- */}
      <Card className="p-4 sm:p-5">
        <PanelHeader
          title="Month by month"
          description={`${MONTHS_IN_CHART} months. Use the calendar to look at any other ${MONTHS_IN_CHART}.`}
          range={data.monthsRange}
          param="m"
          unit="month"
        />
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          {showMoney && (
            <BarChart
              heading="Earnings"
              data={data.months}
              value={(b) => b.totalPay}
              format={(n) => formatGBP(n, { compact: true })}
            />
          )}
          <BarChart
            heading="Hours"
            data={data.months}
            value={(b) => b.hours}
            format={(n) => formatHoursMinsWords(n)}
          />
        </div>
        <div className="mt-5 pt-4 border-t border-border">
          {data.months.map((m) => (
            <Row
              key={m.key}
              label={m.label}
              sub={
                m.hours > 0 || m.deliveries > 0
                  ? periodSummary(m, isDriver)
                  : "No shifts"
              }
              value={showMoney ? formatGBP(m.totalPay) : hoursText(m.hours)}
              strong={m.isCurrent}
            />
          ))}
        </div>
      </Card>

      {/* ---- Deliveries (drivers only), week by week ---- */}
      {isDriver && (
        <Card className="p-4 sm:p-5">
          <PanelHeader
            title="Your deliveries"
            description="Drops week by week, and what they paid."
            range={data.deliveryRange}
            param="d"
            unit="week"
            span={{
              param: "dn",
              value: data.selection.deliveryWeeks,
              options: DELIVERY_WEEK_OPTIONS,
            }}
          />
          <BarChart
            heading="Drops per week"
            data={data.deliveryWeeks}
            value={(b) => b.deliveries}
            format={(n) => String(n)}
          />
          <div className="mt-5 pt-4 border-t border-border">
            {deliveryWeeksNewestFirst.map((w) => (
              <Row
                key={w.key}
                label={`Week of ${w.label}`}
                sub={w.deliveries > 0 ? dropBreakdown(w) : "No deliveries"}
                value={showMoney ? formatGBP(w.deliveryPay) : `${w.deliveries} drops`}
                strong={w.isCurrent}
              />
            ))}
          </div>
          <div className="mt-5 pt-4 border-t border-border">
            <p className="text-[11px] uppercase tracking-[0.12em] text-text-muted mb-1">
              Totals for {data.deliveryRange.label}
            </p>
            {/* All four types are listed even at zero. A driver checking a
                quiet week needs to see that misc drops were counted and came to
                nothing — a missing row reads as "not counted", which is exactly
                the doubt this panel exists to remove. */}
            <Row
              label="Short deliveries"
              sub={`${data.deliveryTotal.sd} at ${formatGBP(rates.shortRate)} each`}
              value={formatGBP(data.deliveryTotal.sd * rates.shortRate)}
            />
            <Row
              label="Long deliveries"
              sub={`${data.deliveryTotal.ld} at ${formatGBP(rates.longRate)} each`}
              value={formatGBP(data.deliveryTotal.ld * rates.longRate)}
            />
            <Row
              label="Miscellaneous short"
              sub={`${data.deliveryTotal.sm} at ${formatGBP(rates.shortRate)} each`}
              value={formatGBP(data.deliveryTotal.sm * rates.shortRate)}
            />
            <Row
              label="Miscellaneous long"
              sub={`${data.deliveryTotal.lm} at ${formatGBP(rates.longRate)} each`}
              value={formatGBP(data.deliveryTotal.lm * rates.longRate)}
            />
            <Row
              label="Delivery pay"
              sub={dropBreakdown(data.deliveryTotal) || "No deliveries"}
              value={formatGBP(data.deliveryTotal.deliveryPay)}
              strong
            />
          </div>
        </Card>
      )}

      {/* ---- Pattern. One picker drives both panels — they describe the same
              window, and splitting them would invite comparing two spans. ---- */}
      <Card className="p-4 sm:p-5">
        <PanelHeader
          title="How you've been working"
          description={`Your last ${PATTERN_WEEKS} weeks. Use the calendar to look at any other ${PATTERN_WEEKS}.`}
          range={data.patternRange}
          param="p"
          unit="week"
        />
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          <div>
            <p className="text-[11px] uppercase tracking-[0.12em] text-text-muted mb-3">
              Your usual days
            </p>
            <div className="flex flex-col gap-2">
              {data.weekdays.map((w) => {
                const pct =
                  maxWeekdayHours > 0 && w.hours > 0
                    ? Math.max((w.hours / maxWeekdayHours) * 100, 3)
                    : 0;
                return (
                  <div key={w.index} className="flex items-center gap-2 sm:gap-3">
                    <span className="w-8 shrink-0 text-xs text-text-muted">{w.short}</span>
                    <div className="flex-1 h-6 rounded-md bg-surface-hover overflow-hidden">
                      <div
                        className={cn(
                          "h-full rounded-md",
                          w.index === data.busiestWeekday?.index
                            ? "bg-gold"
                            : "bg-gold/45",
                        )}
                        style={{ width: `${pct}%` }}
                      />
                    </div>
                    <span className="w-11 sm:w-14 shrink-0 text-right text-xs text-text-subtle tabular-nums">
                      {w.hours > 0 ? hoursText(w.hours) : "—"}
                    </span>
                  </div>
                );
              })}
            </div>
          </div>

          <div>
            <p className="text-[11px] uppercase tracking-[0.12em] text-text-muted mb-1">
              Your working pattern
            </p>
            <Row
              label="Busiest day"
              value={
                data.busiestWeekday
                  ? `${data.busiestWeekday.long.slice(0, 3)} · ${hoursText(data.busiestWeekday.hours)}`
                  : "—"
              }
            />
            <Row
              label="Average shift length"
              value={data.avgDayLength > 0 ? hoursText(data.avgDayLength) : "—"}
            />
            <Row
              label="Average days per week"
              value={data.avgDaysPerWeek > 0 ? data.avgDaysPerWeek.toFixed(1) : "—"}
            />
            <Row
              label="Average week"
              value={
                showMoney
                  ? `${hoursText(data.avgHoursPerWeek)} · ${formatGBP(data.avgPayPerWeek)}`
                  : hoursText(data.avgHoursPerWeek)
              }
            />
            <Row label="Usual start" value={data.typicalStart ?? "—"} />
            <Row label="Usual finish" value={data.typicalFinish ?? "—"} />
            <Row
              label="Longest run of days"
              value={
                data.longestStreak > 0
                  ? `${data.longestStreak} day${data.longestStreak === 1 ? "" : "s"}`
                  : "—"
              }
            />
            <Row
              label="Best week"
              value={
                data.bestWeek
                  ? showMoney
                    ? formatGBP(data.bestWeek.totalPay)
                    : hoursText(data.bestWeek.hours)
                  : "—"
              }
              sub={data.bestWeek ? `Week of ${data.bestWeek.label}` : undefined}
            />
            <Row
              label="Total for these weeks"
              value={showMoney ? formatGBP(pattern.totalPay) : hoursText(pattern.hours)}
              sub={`${hoursText(pattern.hours)} over ${pattern.daysWorked} day${pattern.daysWorked === 1 ? "" : "s"}`}
              strong
            />
          </div>
        </div>
      </Card>

      {!showMoney && (
        <Card className="border-warning/40">
          <p className="text-sm text-text-muted">
            Your pay rates aren&apos;t set up on your profile yet, so this page
            shows hours only. Ask your manager to add them and your earnings will
            appear here.
          </p>
        </Card>
      )}

      <p className="text-xs text-text-muted">
        These figures are worked out from the hours your manager has confirmed,
        or your clocked times where a day hasn&apos;t been signed off yet — so a
        day that&apos;s still to be approved can change. A shift you&apos;re
        part-way through counts once you clock out. This page is for information
        only; it isn&apos;t a payslip. If something looks wrong, speak to your
        manager.
      </p>
    </div>
  );
}
