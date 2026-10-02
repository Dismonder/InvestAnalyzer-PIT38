/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React from 'react';
import { clsx } from 'clsx';

/* ---------------------------------------------------------------------------
 * Input — spójne pole formularza
 *
 * Wzorzec bazowy: bg-slate-50 dark:bg-slate-800 border border-slate-200
 * dark:border-slate-700 text-slate-900 dark:text-white rounded-xl
 *
 * Warianty:
 * - default  → standardowe pole (AddTransactionModal)
 * - search   → mniejsze py, z ikoną po lewej (PortfolioDashboard, FifoDetails)
 * - numeric  → font-mono (kwoty finansowe)
 * - code     → text-center tracking-[0.4em] font-mono text-2xl (OTP/2FA)
 * ------------------------------------------------------------------------- */

export type InputVariant = 'default' | 'search' | 'numeric' | 'code';

export interface InputProps extends Omit<React.InputHTMLAttributes<HTMLInputElement>, 'size'> {
  variant?: InputVariant;
  label?: string;
  error?: string;
  helpText?: string;
  /** Ikona wyświetlana po lewej stronie (np. Search z lucide-react). */
  prefixIcon?: React.ReactNode;
  /** Ikona lub element po prawej stronie (np. przycisk kopiowania). */
  suffixElement?: React.ReactNode;
  /** Pełna szerokość (domyślnie true). */
  fullWidth?: boolean;
}

const baseClasses =
  'bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 ' +
  'text-slate-900 dark:text-white focus:outline-none';

const variantClasses: Record<InputVariant, string> = {
  default: 'px-3 py-2 rounded-xl',
  search: 'pl-9 pr-3 py-1.5 rounded-xl text-xs',
  numeric: 'px-3 py-2 rounded-xl font-mono',
  code: 'text-center tracking-[0.4em] font-mono text-2xl py-3 px-4 rounded-2xl focus:ring-2 focus:ring-blue-500',
};

export const Input = React.forwardRef<HTMLInputElement, InputProps>(
  (
    {
      variant = 'default',
      label,
      error,
      helpText,
      prefixIcon,
      suffixElement,
      fullWidth = true,
      className,
      id,
      ...rest
    },
    ref,
  ) => {
    const inputId = id || (label ? `input-${label.replace(/\s+/g, '-').toLowerCase()}` : undefined);
    const hasPrefix = Boolean(prefixIcon) || variant === 'search';

    return (
      <div className={clsx(fullWidth && 'w-full')}>
        {label && (
          <label
            htmlFor={inputId}
            className="block text-slate-700 dark:text-slate-300 font-medium mb-1 text-sm"
          >
            {label}
          </label>
        )}
        <div className={clsx('relative', fullWidth && 'w-full')}>
          {hasPrefix && prefixIcon && (
            <div className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400 pointer-events-none">
              {prefixIcon}
            </div>
          )}
          <input
            ref={ref}
            id={inputId}
            className={clsx(
              baseClasses,
              variantClasses[variant],
              fullWidth && 'w-full',
              error && 'border-rose-400 dark:border-rose-600 focus:ring-rose-500',
              !error && variant !== 'code' && 'focus:ring-2 focus:ring-blue-500',
              className,
            )}
            aria-invalid={error ? 'true' : undefined}
            aria-describedby={error ? `${inputId}-error` : helpText ? `${inputId}-help` : undefined}
            {...rest}
          />
          {suffixElement && (
            <div className="absolute right-2 top-1/2 -translate-y-1/2">
              {suffixElement}
            </div>
          )}
        </div>
        {error && (
          <p id={`${inputId}-error`} className="mt-1 text-xs text-rose-500 dark:text-rose-400">
            {error}
          </p>
        )}
        {helpText && !error && (
          <p id={`${inputId}-help`} className="mt-1 text-xs text-slate-500 dark:text-slate-400">
            {helpText}
          </p>
        )}
      </div>
    );
  },
);

Input.displayName = 'Input';

/* ---------------------------------------------------------------------------
 * TextArea — wieloliniowe pole tekstowe w tym samym stylu
 * ------------------------------------------------------------------------- */

export interface TextAreaProps extends React.TextareaHTMLAttributes<HTMLTextAreaElement> {
  label?: string;
  error?: string;
  helpText?: string;
  fullWidth?: boolean;
}

export const TextArea = React.forwardRef<HTMLTextAreaElement, TextAreaProps>(
  ({ label, error, helpText, fullWidth = true, className, id, ...rest }, ref) => {
    const textareaId = id || (label ? `textarea-${label.replace(/\s+/g, '-').toLowerCase()}` : undefined);

    return (
      <div className={clsx(fullWidth && 'w-full')}>
        {label && (
          <label
            htmlFor={textareaId}
            className="block text-slate-700 dark:text-slate-300 font-medium mb-1 text-sm"
          >
            {label}
          </label>
        )}
        <textarea
          ref={ref}
          id={textareaId}
          className={clsx(
            baseClasses,
            'px-3 py-2 rounded-xl resize-y',
            fullWidth && 'w-full',
            error && 'border-rose-400 dark:border-rose-600',
            !error && 'focus:ring-2 focus:ring-blue-500',
            className,
          )}
          aria-invalid={error ? 'true' : undefined}
          {...rest}
        />
        {error && (
          <p className="mt-1 text-xs text-rose-500 dark:text-rose-400">{error}</p>
        )}
        {helpText && !error && (
          <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">{helpText}</p>
        )}
      </div>
    );
  },
);

TextArea.displayName = 'TextArea';
