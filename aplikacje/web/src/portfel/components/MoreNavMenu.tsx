import React from 'react';
import type { LucideIcon } from 'lucide-react';

export interface MoreNavItem {
  id: string;
  label: string;
  icon: LucideIcon;
  badge: string | number | null;
}

export default function MoreNavMenu({ items, activeTab, language, onSelect }: {
  items: MoreNavItem[];
  activeTab: string;
  language: string;
  onSelect: (id: string) => void;
}) {
  return (
    <div role="menu" id="bottom-nav-more-menu" aria-label={language === 'pl' ? 'Więcej sekcji' : 'More sections'} className="rounded-2xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 shadow-2xl p-2 grid grid-cols-2 gap-1">
      {items.map(({ id, label, icon: Icon, badge }) => (
        <button
          key={id}
          id={`bottom-nav-more-${id}`}
          role="menuitem"
          onClick={() => onSelect(id)}
          className={`flex items-center gap-2 rounded-xl px-3 py-2.5 text-left text-xs font-semibold transition-colors cursor-pointer ${activeTab === id ? 'bg-blue-50 dark:bg-blue-950 text-blue-600 dark:text-blue-400' : 'text-slate-700 dark:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800'}`}
        >
          <Icon className="w-4 h-4 shrink-0" />
          <span className="truncate">{label}</span>
          {badge !== null && <span className="ml-auto text-[10px] font-mono">{badge}</span>}
        </button>
      ))}
    </div>
  );
}
