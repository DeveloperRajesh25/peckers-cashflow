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
  { href: "/manager/settings", label: "Settings", icon: SettingsIcon },
];

// ---- Employee / crew portal (/employee/*) ----
export const employeeNav: NavItem[] = [
  { href: "/employee/attendance", label: "Clock In/Out", icon: ClockIcon },
  { href: "/employee/shifts", label: "My Shifts", icon: CalendarIcon },
  { href: "/employee/profile", label: "Profile", icon: UserCircleIcon },
  { href: "/employee/settings", label: "Settings", icon: SettingsIcon },
];

// ---- Cover driver portal (/cover-driver/*) ----
// Deliberately minimal: cover drivers are not on the rota, so there is no
// "My Shifts", and they have no HR profile page.
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

// Bottom-nav (mobile) shows at most 5 items. Pick the most-used per portal.
export const BOTTOM_NAV_FOR_PORTAL: Record<Portal, NavItem[]> = {
  admin: [
    adminNav[0], // Dashboard
    adminNav[1], // Live
    adminNav[2], // Rota
    adminNav[4], // Employees
    adminNav[3], // Alerts
  ],
  manager: [
    managerNav[0], // Live
    managerNav[1], // Rota
    managerNav[2], // Employees
    managerNav[3], // Alerts
    managerNav[4], // Entries
  ],
  employee: employeeNav,
  cover_driver: coverDriverNav,
};
