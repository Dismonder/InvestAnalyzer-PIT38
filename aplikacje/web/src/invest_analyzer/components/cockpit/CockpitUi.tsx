import React from "react";
import { useZamknijEscape } from '../../../shared/useZamknijEscape';
import { X } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { useUiMotion } from "./uiMotion";

type Tone = "ready" | "evidence" | "review" | "blocked" | "info";

const toneClasses: Record<Tone, string> = {
  ready: "border-emerald-200 bg-emerald-50 text-emerald-950 dark:border-emerald-800 dark:bg-emerald-950/30 dark:text-emerald-100",
  evidence: "border-amber-200 bg-amber-50 text-amber-950 dark:border-amber-800 dark:bg-amber-950/30 dark:text-amber-100",
  review: "border-blue-200 bg-blue-50 text-blue-950 dark:border-blue-800 dark:bg-blue-950/30 dark:text-blue-100",
  blocked: "border-rose-200 bg-rose-50 text-rose-950 dark:border-rose-800 dark:bg-rose-950/30 dark:text-rose-100",
  info: "border-slate-200 bg-white text-slate-950 dark:border-slate-700 dark:bg-gray-800 dark:text-slate-100",
};

const pillToneClasses: Record<Tone, string> = {
  ready: "bg-emerald-100 text-emerald-800 ring-emerald-200 dark:bg-emerald-900/40 dark:text-emerald-200 dark:ring-emerald-800",
  evidence: "bg-amber-100 text-amber-800 ring-amber-200 dark:bg-amber-900/40 dark:text-amber-200 dark:ring-amber-800",
  review: "bg-blue-100 text-blue-800 ring-blue-200 dark:bg-blue-900/40 dark:text-blue-200 dark:ring-blue-800",
  blocked: "bg-rose-100 text-rose-800 ring-rose-200 dark:bg-rose-900/40 dark:text-rose-200 dark:ring-rose-800",
  info: "bg-slate-100 text-slate-700 ring-slate-200 dark:bg-slate-800 dark:text-slate-200 dark:ring-slate-700",
};

function joinClasses(...classes: Array<string | false | null | undefined>): string {
  return classes.filter(Boolean).join(" ");
}

interface CockpitMetric {
  label: string;
  value: React.ReactNode;
  helper?: React.ReactNode;
  tone?: Tone;
}

interface CockpitStatusHeroProps {
  eyebrow: string;
  title: string;
  summary: string;
  tone?: Tone;
  metrics?: CockpitMetric[];
  action?: React.ReactNode;
}

export function CockpitStatusHero({
  eyebrow,
  title,
  summary,
  tone = "info",
  metrics = [],
  action,
}: CockpitStatusHeroProps) {
  const uiMotion = useUiMotion();
  return (
    <motion.section data-motion="cockpit-status-hero" className={joinClasses("rounded-2xl border p-5 shadow-sm md:p-6", toneClasses[tone])} {...uiMotion.fadeUp()}>
      <div className="grid gap-5 xl:grid-cols-[minmax(0,1.5fr)_minmax(280px,0.8fr)] xl:items-start">
        <div>
          <p className="text-xs font-semibold uppercase tracking-[0.18em] opacity-70">{eyebrow}</p>
          <h2 className="mt-2 text-2xl font-bold tracking-tight md:text-3xl">{title}</h2>
          <p className="mt-2 max-w-3xl text-sm leading-6 opacity-85">{summary}</p>
          {metrics.length > 0 && <MetricStrip metrics={metrics} className="mt-5" compact />}
        </div>
        {action ? <div className="xl:justify-self-end">{action}</div> : null}
      </div>
    </motion.section>
  );
}

interface RecommendedActionCardProps {
  title: string;
  description: string;
  ctaLabel?: string;
  onClick?: () => void;
  secondaryAction?: React.ReactNode;
}

export function RecommendedActionCard({
  title,
  description,
  ctaLabel,
  onClick,
  secondaryAction,
}: RecommendedActionCardProps) {
  const uiMotion = useUiMotion();
  return (
    <motion.div data-motion="recommended-action-card" className="rounded-xl bg-white/85 p-4 text-slate-900 shadow-sm ring-1 ring-black/5 dark:bg-gray-950/35 dark:text-white dark:ring-white/10" {...uiMotion.fadeUp(0.06)}>
      <p className="text-xs font-semibold uppercase tracking-[0.16em] text-slate-500 dark:text-slate-400">Najważniejsza akcja</p>
      <h3 className="mt-2 text-base font-bold">{title}</h3>
      <p className="mt-1 text-sm leading-6 text-slate-600 dark:text-slate-300">{description}</p>
      {(ctaLabel || secondaryAction) && (
        <div className="mt-4 flex flex-wrap gap-2">
          {ctaLabel ? (
            <motion.button
              type="button"
              onClick={onClick}
              whileHover={uiMotion.hoverPop}
              whileTap={uiMotion.tapPress}
              className="rounded-lg bg-blue-600 px-3 py-2 text-xs font-semibold text-white transition hover:bg-blue-700 dark:bg-blue-600 dark:hover:bg-blue-700"
            >
              {ctaLabel}
            </motion.button>
          ) : null}
          {secondaryAction}
        </div>
      )}
    </motion.div>
  );
}

interface MetricStripProps {
  metrics: CockpitMetric[];
  compact?: boolean;
  className?: string;
}

export function MetricStrip({ metrics, compact = false, className }: MetricStripProps) {
  const uiMotion = useUiMotion();
  if (metrics.length === 0) {
    return null;
  }
  return (
    <div className={joinClasses("grid gap-3", compact ? "grid-cols-2 md:grid-cols-3" : "grid-cols-1 sm:grid-cols-2 xl:grid-cols-4", className)}>
      {metrics.map((metric, index) => (
        <motion.div
          key={metric.label}
          data-motion="metric-card"
          {...uiMotion.fadeUp(index * 0.03)}
          className={joinClasses(
            "rounded-xl border bg-white/80 p-3 shadow-sm dark:bg-gray-950/30",
            metric.tone ? toneClasses[metric.tone] : "border-white/70 dark:border-white/10",
          )}
        >
          <p className="text-[11px] font-semibold uppercase tracking-[0.14em] opacity-65">{metric.label}</p>
          <p className="mt-1 text-lg font-bold">{metric.value}</p>
          {metric.helper ? <p className="mt-1 text-xs opacity-70">{metric.helper}</p> : null}
        </motion.div>
      ))}
    </div>
  );
}

export interface ProgressStep {
  id: string;
  label: string;
  status: "ready" | "evidence" | "review" | "blocked" | "not_ready" | "info";
  count?: number;
  onClick?: () => void;
}

function stepTone(status: ProgressStep["status"]): Tone {
  if (status === "ready") return "ready";
  if (status === "evidence") return "evidence";
  if (status === "review") return "review";
  if (status === "blocked" || status === "not_ready") return "blocked";
  return "info";
}

export function ProgressStepRail({ steps }: { steps: ProgressStep[] }) {
  const uiMotion = useUiMotion();
  if (steps.length === 0) {
    return null;
  }
  return (
    <div className="grid grid-cols-2 gap-2 md:grid-cols-3 xl:grid-cols-6">
      {steps.map((step, index) => {
        const content = (
          <>
            <span className={joinClasses("inline-flex h-2.5 w-2.5 rounded-full ring-2 ring-white dark:ring-gray-900", pillToneClasses[stepTone(step.status)])} />
            <span className="font-semibold">{step.label}</span>
            {step.count ? <span className="ml-auto rounded-full bg-white px-2 py-0.5 text-[11px] font-bold text-slate-700 ring-1 ring-slate-200 dark:bg-gray-900 dark:text-slate-200 dark:ring-gray-700">{step.count}</span> : null}
          </>
        );
        const className = "flex min-h-11 items-center gap-2 rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm text-slate-800 shadow-sm transition hover:border-blue-200 hover:bg-blue-50 dark:border-gray-700 dark:bg-gray-800 dark:text-slate-100 dark:hover:border-blue-800 dark:hover:bg-blue-950/30";
        return step.onClick ? (
          <motion.button key={step.id} type="button" data-motion="progress-step" onClick={step.onClick} className={className} {...uiMotion.fadeUp(index * 0.03)} whileHover={uiMotion.hoverPop} whileTap={uiMotion.tapPress}>
            {content}
          </motion.button>
        ) : (
          <motion.div key={step.id} data-motion="progress-step" className={className} {...uiMotion.fadeUp(index * 0.03)}>
            {content}
          </motion.div>
        );
      })}
    </div>
  );
}

export function DisclosureSection({
  title,
  summary,
  children,
  defaultOpen = false,
}: {
  title: string;
  summary?: string;
  children: React.ReactNode;
  defaultOpen?: boolean;
}) {
  const uiMotion = useUiMotion();
  const [open, setOpen] = React.useState(defaultOpen);
  return (
    <section className="rounded-xl border border-slate-200 bg-white shadow-sm dark:border-gray-700 dark:bg-gray-800">
      <motion.button
        type="button"
        onClick={() => setOpen((value) => !value)}
        whileHover={uiMotion.hoverPop}
        whileTap={uiMotion.tapPress}
        className="flex w-full items-start justify-between gap-4 px-4 py-3 text-left"
        aria-expanded={open}
      >
        <span>
          <span className="block font-semibold text-slate-950 dark:text-white">{title}</span>
          {summary ? <span className="mt-1 block text-sm text-slate-500 dark:text-slate-400">{summary}</span> : null}
        </span>
        <span className="rounded-full bg-slate-100 px-2 py-1 text-xs font-semibold text-slate-600 dark:bg-gray-900 dark:text-slate-300">
          {open ? "Ukryj" : "Pokaż"}
        </span>
      </motion.button>
      <AnimatePresence initial={false}>
        {open ? (
          <motion.div data-motion="disclosure-reveal" className="overflow-hidden border-t border-slate-100 dark:border-gray-700" {...uiMotion.collapseReveal}>
            <div className="px-4 py-4">{children}</div>
          </motion.div>
        ) : null}
      </AnimatePresence>
    </section>
  );
}

interface InsightDrawerSection {
  title: string;
  content: React.ReactNode;
}

type InsightDrawerType = "calculation" | "source" | "evidence" | "history_row" | "technical";

interface InsightDrawerAction {
  label: string;
  onClick?: () => void;
  variant?: "primary" | "secondary";
  disabled?: boolean;
  title?: string;
  closeOnClick?: boolean;
}

export interface ActiveInsightDrawer {
  type: InsightDrawerType;
  id?: string;
  title: string;
  subtitle?: string;
  payload?: unknown;
  sections?: InsightDrawerSection[];
  actions?: InsightDrawerAction[];
  children?: React.ReactNode;
}

export type OpenInsightDrawer = (drawer: ActiveInsightDrawer) => void;

export function InsightDrawer({
  open,
  title,
  subtitle,
  sections = [],
  actions = [],
  children,
  onClose,
}: {
  open: boolean;
  title: string;
  subtitle?: string;
  sections?: InsightDrawerSection[];
  actions?: InsightDrawerAction[];
  children?: React.ReactNode;
  onClose: () => void;
}) {
  const uiMotion = useUiMotion();
  const refSzuflady = useZamknijEscape(open, onClose);
  const drawerActions = actions.length > 0
    ? actions
    : [{ label: "Zamknij", onClick: onClose, variant: "secondary" as const, closeOnClick: false }];
  return (
    <AnimatePresence>
      {open ? (
      <>
    <motion.div
      key="insight-drawer-backdrop"
      data-motion="insight-drawer-backdrop"
      className="fixed inset-0 z-50 bg-slate-950/20 backdrop-blur-[1px] dark:bg-black/35"
      onClick={onClose}
      {...uiMotion.fadeIn()}
      exit={{ opacity: 0 }}
    />
    <motion.aside
      key="insight-drawer"
      ref={refSzuflady}
      tabIndex={-1}
      role="dialog"
      aria-modal="true"
      aria-label={title}
      data-motion="insight-drawer"
      className="outline-none fixed inset-y-0 right-0 z-50 flex w-full max-w-xl flex-col border-l border-slate-200 bg-white shadow-2xl dark:border-gray-700 dark:bg-gray-900"
      {...uiMotion.drawerPanel}
    >
      <div className="flex items-start justify-between gap-4 border-b border-slate-100 p-5 dark:border-gray-800">
        <div>
          <p className="text-xs font-semibold uppercase tracking-[0.18em] text-blue-600 dark:text-blue-300">Panel szczegółów</p>
          <h2 className="mt-1 text-xl font-bold text-slate-950 dark:text-white">{title}</h2>
          {subtitle ? <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">{subtitle}</p> : null}
        </div>
        <button
          type="button"
          onClick={onClose}
          className="rounded-full p-2 text-slate-500 transition hover:bg-slate-100 hover:text-slate-900 dark:text-slate-300 dark:hover:bg-gray-800 dark:hover:text-white"
          aria-label="Zamknij panel szczegółów"
        >
          <X size={18} />
        </button>
      </div>
      <div className="custom-scrollbar flex-1 space-y-4 overflow-y-auto p-5">
        {sections.map((section, index) => (
          <motion.section key={section.title} data-motion="insight-drawer-section" className="rounded-xl border border-slate-200 bg-slate-50 p-4 dark:border-gray-700 dark:bg-gray-800/70" {...uiMotion.fadeUp(index * 0.04)}>
            <h3 className="text-sm font-bold text-slate-950 dark:text-white">{section.title}</h3>
            <div className="mt-2 text-sm leading-6 text-slate-600 dark:text-slate-300">{section.content}</div>
          </motion.section>
        ))}
        {children}
      </div>
      <div className="border-t border-slate-100 bg-white p-4 dark:border-gray-800 dark:bg-gray-900">
        <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
          {drawerActions.map((action) => (
            <button
              key={action.label}
              type="button"
              disabled={action.disabled}
              title={action.title}
              onClick={() => {
                action.onClick?.();
                if (action.closeOnClick !== false) {
                  onClose();
                }
              }}
              className={joinClasses(
                "rounded-xl px-4 py-2 text-sm font-semibold transition disabled:cursor-not-allowed disabled:opacity-60",
                action.variant === "primary"
                  ? "bg-blue-600 text-white shadow-sm hover:bg-blue-700"
                  : "border border-slate-200 text-slate-700 hover:bg-slate-50 dark:border-gray-700 dark:text-slate-200 dark:hover:bg-gray-800",
              )}
            >
              {action.label}
            </button>
          ))}
        </div>
      </div>
    </motion.aside>
      </>
      ) : null}
    </AnimatePresence>
  );
}

export function SourceRolePill({ role, label }: { role: string; label?: string }) {
  const normalized = role.toLowerCase();
  const tone: Tone = normalized.includes("primary") || normalized === "tax" ? "ready"
    : normalized.includes("candidate") || normalized.includes("review") ? "review"
    : normalized.includes("evidence") || normalized.includes("analytics") || normalized.includes("reconciliation") ? "evidence"
    : normalized.includes("raw") ? "review"
    : "info";
  return (
    <span className={joinClasses("inline-flex items-center rounded-full px-2.5 py-1 text-xs font-semibold ring-1", pillToneClasses[tone])}>
      {label || role}
    </span>
  );
}

export function IssueSeverityBadge({ severity, label }: { severity: string; label?: string }) {
  const normalized = severity.toLowerCase();
  const tone: Tone = normalized.includes("error") ? "review"
    : normalized.includes("evidence") ? "evidence"
    : normalized.includes("warning") || normalized.includes("review") ? "review"
    : "info";
  return (
    <span className={joinClasses("inline-flex items-center rounded-full px-2.5 py-1 text-xs font-semibold ring-1", pillToneClasses[tone])}>
      {label || severity}
    </span>
  );
}
