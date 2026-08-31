import * as React from "react";
import {
  AlertIcon,
  CalendarIcon,
  ChartIcon,
  ClockIcon,
  GridIcon,
  HomeIcon,
  KeyIcon,
  ListIcon,
  RadioIcon,
  ShoppingBagIcon,
  SettingsIcon,
  UserCircleIcon,
  UsersIcon,
  WalletIcon,
} from "@/components/ui/icons";
import type { Portal } from "@/lib/types";

export type NavItem = {
  href: string;
  label: string;
  icon: React.ComponentType<{ size?: number }>;
  group?: string;
  /** Used by the mobile bottom bar only, where a tab is a fifth of the screen. */
  shortLabel?: string;
};

// ---- Admin portal (root URLs) ----
export const adminNav: NavItem[] = [
  { href: "/dashboard", label: "Dashboard", icon: HomeIcon },
  { href: "/vm-analytics/executive", label: "VM Analytics", icon: ChartIcon },
  { href: "/live", label: "Live", icon: RadioIcon, group: "Operations" },
  { href: "/rota", label: "Rota", icon: GridIcon, group: "Operations" },
  { href: "/alerts", label: "Alerts", icon: AlertIcon, group: "Operations" },
  { href: "/employees", label: "Employees", icon: UsersIcon, group: "People" },
  { href: "/managers", label: "Managers", icon: KeyIcon, group: "People" },
  { href: "/cash-flow", label: "Cash Flow", icon: WalletIcon, group: "Finance" },
  { href: "/cash-flow/payout", label: "Tuesday Payout", icon: CalendarIcon, group: "Finance" },
  { href: "/cash-flow/history", label: "Payout History", icon: ListIcon, group: "Finance" },
  { href: "/ni-monthly", label: "NI (Monthly)", icon: CalendarIcon, group: "Finance" },
  { href: "/analytics", label: "Analytics", icon: ChartIcon, group: "Finance" },
  { href: "/settings", label: "Settings", icon: SettingsIcon },
];

// ---- Manager portal (/manager/*) ----
export const managerNav: NavItem[] = [
  { href: "/manager/live", label: "Live", icon: RadioIcon },
  { href: "/manager/rota", label: "Rota", icon: GridIcon },
  { href: "/manager/employees", label: "Employees", icon: UsersIcon },
  { href: "/manager/alerts", label: "Alerts", icon: AlertIcon },
  { href: "/manager/cash-flow", label: "Cash Flow", icon: WalletIcon, group: "Finance" },
  { href: "/manager/cash-flow/payout", label: "Tuesday Payout", icon: CalendarIcon, group: "Finance" },
  { href: "/manager/cash-flow/history", label: "Payout History", icon: ListIcon, group: "Finance" },
  { href: "/manager/ni-monthly", label: "NI (Monthly)", icon: CalendarIcon, group: "Finance" },
  { href: "/manager/analytics", label: "Analytics", icon: ChartIcon, group: "Finance" },
  // The manager's twin of the admin Weekly Report. VM Analytics itself stays
  // admin-only, so this is the one screen from that module they can reach.
  { href: "/manager/weekly-report", label: "Weekly Report", icon: ShoppingBagIcon, group: "Finance" },
  { href: "/manager/settings", label: "Settings", icon: SettingsIcon },
];

// ---- Employee / crew portal (/employee/*) ----
export const employeeNav: NavItem[] = [
  { href: "/employee/attendance", label: "Clock In/Out", icon: ClockIcon, shortLabel: "Clock" },
  { href: "/employee/shifts", label: "My Shifts", icon: CalendarIcon, shortLabel: "Shifts" },
  { href: "/employee/analytics", label: "Analytics", icon: ChartIcon },
  { href: "/employee/profile", label: "Profile", icon: UserCircleIcon },
  { href: "/employee/settings", label: "Settings", icon: SettingsIcon },
];

// ---- Cover driver portal (/cover-driver/*) ----
// Deliberately minimal: a cover driver's bookings live on the manager-facing
// Rota, so there is no self-service "My Shifts", and they have no HR profile.
export const coverDriverNav: NavItem[] = [
  { href: "/cover-driver/attendance", label: "Clock In/Out", icon: ClockIcon },
  { href: "/cover-driver/settings", label: "Settings", icon: SettingsIcon },
];

export const NAV_FOR_PORTAL: Record<Portal, NavItem[]> = {
  admin: adminNav,
  manager: managerNav,
  employee: employeeNav,
  cover_driver: coverDriverNav,
};

// Bottom-nav (mobile): the most-used pages get a dedicated tab. When a portal
// has more pages than fit, the last tab becomes a "More" button that opens a
// sheet listing the full menu — so every page stays reachable on mobile. Keep
// these to 4 so the 5th slot is free for that "More" tab (see BottomNav).
export const BOTTOM_NAV_FOR_PORTAL: Record<Portal, NavItem[]> = {
  admin: [
    adminNav[0], // Dashboard
    adminNav[1], // VM Analytics
    adminNav[2], // Live
    adminNav[4], // Alerts
  ],
  manager: [
    managerNav[0], // Live
    managerNav[1], // Rota
    managerNav[2], // Employees
    managerNav[3], // Alerts
  ],
  // 5 pages now, so one has to give up its tab. Settings is the least-visited
  // (theme, logout, password) and is the natural one to move into "More".
  employee: [
    employeeNav[0], // Clock In/Out
    employeeNav[1], // My Shifts
    employeeNav[2], // Analytics
    employeeNav[3], // Profile
  ],
  cover_driver: coverDriverNav, // only 2 pages — all fit
};
