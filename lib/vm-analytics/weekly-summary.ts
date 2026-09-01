/**
 * Weekly Summary Dashboard calculations
 * Handles all metric calculations for the manager-input Weekly Summary dashboard
 */

export interface WeeklySummaryInputs {
  cogs?: number;
  cogs_hitchin?: number;
  fillings_and_samosas?: number;
  /** Stock supplied to Meppershall — credited back, like the COGS transfer. */
  meppershall?: number;
  packaging_costs?: number;
  marketing?: number;
  labour_cost?: number;
  occupancy_cost?: number;
  aggregator_costs?: number;
  gross_margin_budget_pct?: number;
  labour_budget_pct?: number;
}

export interface SalesData {
  gross_sales: number;
  net_sales: number;
}

export interface WeeklySummaryMetric {
  entity: string;
  actual?: number;
  actual_pct?: number;
  budget?: number;
  budget_pct?: number;
  variance?: number;
  variance_pct?: number;
}

export interface WeeklySummaryData {
  metrics: WeeklySummaryMetric[];
  totals: {
    store_contribution?: number;
    store_contribution_pct?: number;
    net_margin?: number;
    net_margin_pct?: number;
  };
}

/**
 * Helper to coerce various numeric types to a number
 */
function toNum(val: unknown): number {
  if (typeof val === "number") return val;
  if (typeof val === "string") return parseFloat(val) || 0;
  return 0;
}

/**
 * Calculate Gross Margin metrics
 *
 * Gross Margin actual = NET SALES – COGS + COGS_HITCHIN (other store)
 *                        + FILLINGS AND SAMOSAS + MEPPERSHALL
 * Gross Margin actual % = Actual / NET SALES
 * Budget = Budget% * NET SALES
 * Budget % = Budget / NET SALES
 * Variance = Actual - Budget
 * Variance % = Actual% - Budget%
 */
export function calculateGrossMargin(
  netSales: number,
  inputs: WeeklySummaryInputs,
): Omit<WeeklySummaryMetric, "entity"> {
  const cogs = toNum(inputs.cogs) || 0;
  const cogs_hitchin = toNum(inputs.cogs_hitchin) || 0;
  const fillings = toNum(inputs.fillings_and_samosas) || 0;
  const meppershall = toNum(inputs.meppershall) || 0;
  const budgetPct = toNum(inputs.gross_margin_budget_pct) || 0;

  const actual = netSales - cogs + cogs_hitchin + fillings + meppershall;
  const actualPct = netSales > 0 ? actual / netSales : 0;
  const budget = budgetPct * netSales;
  const budgetPct_calc = budgetPct;
  const variance = actual - budget;
  const variancePct = actualPct - budgetPct;

  return {
    actual,
    actual_pct: actualPct,
    budget,
    budget_pct: budgetPct_calc,
    variance,
    variance_pct: variancePct,
  };
}

/**
 * Calculate Labour metrics
 *
 * Labour Actual = manager input
 * Labour % = Actual / NET SALES
 * Budget = Budget% * NET SALES
 * Budget % = Budget / NET SALES
 * Variance = Budget - Actual
 * Variance % = Budget% - Labour%
 */
export function calculateLabour(
  netSales: number,
  inputs: WeeklySummaryInputs,
): Omit<WeeklySummaryMetric, "entity"> {
  const labour = toNum(inputs.labour_cost) || 0;
  const budgetPct = toNum(inputs.labour_budget_pct) || 0;

  const actual = labour;
  const actualPct = netSales > 0 ? actual / netSales : 0;
  const budget = budgetPct * netSales;
  const budgetPct_calc = budgetPct;
  const variance = budget - actual;
  const variancePct = budgetPct - actualPct;

  return {
    actual,
    actual_pct: actualPct,
    budget,
    budget_pct: budgetPct_calc,
    variance,
    variance_pct: variancePct,
  };
}

/**
 * Calculate Occupancy Cost metrics
 *
 * Occupancy Cost Actual = manager input
 * Occupancy Cost % = Actual / NET SALES
 * (No budget/variance for this metric)
 */
export function calculateOccupancyCost(
  netSales: number,
  inputs: WeeklySummaryInputs,
): Omit<WeeklySummaryMetric, "entity"> {
  const actual = toNum(inputs.occupancy_cost) || 0;
  const actualPct = netSales > 0 ? actual / netSales : 0;

  return {
    actual,
    actual_pct: actualPct,
  };
}

/**
 * Calculate Store Contribution metrics
 *
 * Store Contribution = Gross Margin - Labour – Occupancy Cost - Packaging Cost
 * Store Contribution % = Store Contribution / NET SALES
 * (No budget/variance for this metric)
 */
export function calculateStoreContribution(
  netSales: number,
  grossMargin: number,
  labour: number,
  occupancyCost: number,
  packaging: number,
): { contribution: number; contribution_pct: number } {
  const contribution = grossMargin - labour - occupancyCost - packaging;
  const contribution_pct = netSales > 0 ? contribution / netSales : 0;

  return {
    contribution,
    contribution_pct,
  };
}

/**
 * Calculate Net Margin metrics
 *
 * Net Margin = Store Contribution - Aggregator Costs
 * Net Margin % = Net Margin / GROSS SALES (not NET SALES)
 * (No budget/variance for this metric)
 */
export function calculateNetMargin(
  grossSales: number,
  storeContribution: number,
  inputs: WeeklySummaryInputs,
): { net_margin: number; net_margin_pct: number } {
  const aggregatorCosts = toNum(inputs.aggregator_costs) || 0;
  const netMargin = storeContribution - aggregatorCosts;
  const netMarginPct = grossSales > 0 ? netMargin / grossSales : 0;

  return {
    net_margin: netMargin,
    net_margin_pct: netMarginPct,
  };
}

/**
 * Generate complete weekly summary with all metrics and calculations
 */
export function generateWeeklySummary(
  salesData: SalesData,
  inputs: WeeklySummaryInputs,
): WeeklySummaryData {
  const { gross_sales, net_sales } = salesData;

  // Calculate all metrics
  const grossMargin = calculateGrossMargin(net_sales, inputs);
  const labour = calculateLabour(net_sales, inputs);
  const occupancy = calculateOccupancyCost(net_sales, inputs);
  const packaging = toNum(inputs.packaging_costs) || 0;
  const marketing = toNum(inputs.marketing) || 0;
  const cogs = toNum(inputs.cogs) || 0;
  const cogs_hitchin = toNum(inputs.cogs_hitchin) || 0;
  const fillings = toNum(inputs.fillings_and_samosas) || 0;
  const meppershall = toNum(inputs.meppershall) || 0;
  const aggregator = toNum(inputs.aggregator_costs) || 0;

  const { contribution, contribution_pct } = calculateStoreContribution(
    net_sales,
    grossMargin.actual || 0,
    labour.actual || 0,
    occupancy.actual || 0,
    packaging,
  );

  const { net_margin, net_margin_pct } = calculateNetMargin(
    gross_sales,
    contribution,
    inputs,
  );

  const metrics: WeeklySummaryMetric[] = [
    {
      entity: "Gross Sales",
      actual: gross_sales,
    },
    {
      entity: "Net Sales",
      actual: net_sales,
    },
    {
      entity: "COGS",
      actual: cogs,
    },
    {
      entity: "COGS Hitchin",
      actual: cogs_hitchin,
    },
    {
      entity: "Fillings and Samosas",
      actual: fillings,
    },
    // Only on the stores that supply it — a £0.00 row everywhere else would
    // read as a figure someone forgot to enter.
    ...(meppershall !== 0 ? [{ entity: "Meppershall", actual: meppershall }] : []),
    {
      entity: "Gross Margin",
      actual: grossMargin.actual,
      actual_pct: grossMargin.actual_pct,
      budget: grossMargin.budget,
      budget_pct: grossMargin.budget_pct,
      variance: grossMargin.variance,
      variance_pct: grossMargin.variance_pct,
    },
    {
      entity: "Packaging Costs",
      actual: packaging,
    },
    {
      entity: "Marketing",
      actual: marketing,
    },
    {
      entity: "Labour",
      actual: labour.actual,
      actual_pct: labour.actual_pct,
      budget: labour.budget,
      budget_pct: labour.budget_pct,
      variance: labour.variance,
      variance_pct: labour.variance_pct,
    },
    {
      entity: "Occupancy Costs",
      actual: occupancy.actual,
      actual_pct: occupancy.actual_pct,
    },
    {
      entity: "Store Contribution",
      actual: contribution,
      actual_pct: contribution_pct,
    },
    {
      entity: "Aggregator Costs",
      actual: aggregator,
    },
    {
      entity: "Net Margin",
      actual: net_margin,
      actual_pct: net_margin_pct,
    },
  ];

  return {
    metrics,
    totals: {
      store_contribution: contribution,
      store_contribution_pct: contribution_pct,
      net_margin,
      net_margin_pct,
    },
  };
}
