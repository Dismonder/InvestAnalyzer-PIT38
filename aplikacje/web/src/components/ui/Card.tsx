/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React from 'react';
import { clsx } from 'clsx';

/* ---------------------------------------------------------------------------
 * Card — spójna karta z obsługą ciemnego motywu
 *
 * Warianty odpowiadają wzorcom z PortfolioDashboard i TaxDashboard:
 * - default     → bg-white dark:bg-slate-900, border, shadow-sm
 * - interactive → jak default + hover:shadow-lg, hover:scale-[1.015]
 * - sub         → bg-slate-50 dark:bg-slate-800/60, mniejszy padding (panel wewnętrzny)
 * - hero        → bg-slate-900 ciemny baner z białym tekstem
 * - gradient    → bg-gradient-to-br from-blue-900 via-indigo-900 (kafel podatku)
 * ------------------------------------------------------------------------- */

export type CardVariant = 'default' | 'interactive' | 'sub' | 'hero' | 'gradient';

export interface CardProps extends React.HTMLAttributes<HTMLDivElement> {
  variant?: CardVariant;
  /** Dodatkowe padding p-5 sm:p-6 (domyślnie). Wyłącz gdy treść sama zarządza paddingiem. */
  noPadding?: boolean;
}

const variantClasses: Record<CardVariant, string> = {
  default:
    'bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 shadow-sm rounded-2xl',
  interactive:
    'bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 shadow-sm rounded-2xl ' +
    'hover:shadow-lg hover:border-slate-300 dark:hover:border-slate-700 ' +
    'hover:scale-[1.015] hover:-translate-y-0.5 transition-all duration-300 relative overflow-hidden group',
  sub:
    'bg-slate-50 dark:bg-slate-800/60 border border-slate-200 dark:border-slate-700/80 rounded-xl',
  hero:
    'relative overflow-hidden rounded-xl bg-slate-900 text-white border border-slate-800 shadow-lg transition-all',
  gradient:
    'bg-gradient-to-br from-blue-900 via-indigo-900 to-slate-900 text-white ' +
    'shadow-md border border-blue-700/80 rounded-2xl',
};

export const Card = React.forwardRef<HTMLDivElement, CardProps>(
  ({ variant = 'default', noPadding = false, className, children, ...rest }, ref) => {
    return (
      <div
        ref={ref}
        className={clsx(
          variantClasses[variant],
          !noPadding && (variant === 'sub' ? 'p-3.5' : 'p-5 sm:p-6'),
          className,
        )}
        {...rest}
      >
        {children}
      </div>
    );
  },
);

Card.displayName = 'Card';

/* ---------------------------------------------------------------------------
 * CardHeader / CardContent / CardFooter — podsekcje karty
 * ------------------------------------------------------------------------- */

export interface CardSectionProps extends React.HTMLAttributes<HTMLDivElement> {}

export const CardHeader = React.forwardRef<HTMLDivElement, CardSectionProps>(
  ({ className, children, ...rest }, ref) => (
    <div
      ref={ref}
      className={clsx('flex items-center justify-between', className)}
      {...rest}
    >
      {children}
    </div>
  ),
);

CardHeader.displayName = 'CardHeader';

export const CardContent = React.forwardRef<HTMLDivElement, CardSectionProps>(
  ({ className, children, ...rest }, ref) => (
    <div ref={ref} className={clsx('mt-3', className)} {...rest}>
      {children}
    </div>
  ),
);

CardContent.displayName = 'CardContent';

export const CardFooter = React.forwardRef<HTMLDivElement, CardSectionProps>(
  ({ className, children, ...rest }, ref) => (
    <div
      ref={ref}
      className={clsx(
        'mt-3 pt-2.5 border-t border-slate-100 dark:border-slate-800 flex items-center justify-between',
        className,
      )}
      {...rest}
    >
      {children}
    </div>
  ),
);

CardFooter.displayName = 'CardFooter';
