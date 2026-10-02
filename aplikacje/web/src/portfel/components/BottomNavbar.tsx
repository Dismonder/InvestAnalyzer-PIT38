import React, { useState, useRef, useEffect, Suspense } from 'react';
import { leniwyZPonowieniem } from '../../shared/leniwyZPonowieniem';
import { klikalny } from '../../shared/klikalny';
import {
  Wallet,
  Calculator,
  History,
  Briefcase,
  TrendingUp,
  Bell,
  Shield,
  FileSearch,
  Globe,
  Lock,
  Unlock,
  Trash2,
  X,
  Menu,
  SlidersHorizontal,
  RefreshCw,
  Play,
  Pause,
  Activity,
  Zap,
  CheckCircle2,
  Clock,
  Moon,
  Sun,
  Volume2,
  VolumeX,
  MoreHorizontal,
} from 'lucide-react';
import { Language, TwoFactorState } from '../types';
import { getTranslation } from '../i18n/translations';
import { pushNotificationService, AppNotification } from '../services/pushNotificationService';
import { marketDataService, STREAM_SPEED_OPTIONS } from '../services/marketDataService';
import { czyTrybHostowany } from '../../shared/trybHostingu';

const MoreNavMenu = leniwyZPonowieniem(() => import('./MoreNavMenu'));

interface BottomNavbarProps {
  activeTab: string;
  setActiveTab: (tab: string) => void;
  language: Language;
  setLanguage: (lang: Language) => void;
  theme?: 'dark' | 'light';
  setTheme?: (theme: 'dark' | 'light') => void;
  transactionCount?: number;
  brokerCount?: number;
  alertCount?: number;
  openPositionsCount?: number;
  engineFileCount?: number;
  notifications: AppNotification[];
  onMarkNotificationRead: (id: string) => void;
  onClearNotifications: () => void;
  twoFactor: TwoFactorState;
  onLockSession: () => void;
  onUnlockModalOpen: () => void;
  onQuickAddTransaction: () => void;
}

export const BottomNavbar: React.FC<BottomNavbarProps> = ({
  activeTab,
  setActiveTab,
  language,
  setLanguage,
  theme = 'dark',
  setTheme,
  transactionCount = 0,
  brokerCount = 0,
  alertCount = 0,
  openPositionsCount = 0,
  engineFileCount = 0,
  notifications,
  onMarkNotificationRead,
  onClearNotifications,
  twoFactor,
  onLockSession,
  onUnlockModalOpen,
  onQuickAddTransaction,
}) => {
  const t = getTranslation(language);
  const [showNotifMenu, setShowNotifMenu] = useState(false);
  const [showSettingsMenu, setShowSettingsMenu] = useState(false);
  const [showMoreMenu, setShowMoreMenu] = useState(false);
  const notifMenuRef = useRef<HTMLDivElement>(null);
  const notifBtnRef = useRef<HTMLButtonElement>(null);
  const settingsMenuRef = useRef<HTMLDivElement>(null);
  const settingsBtnRef = useRef<HTMLButtonElement>(null);
  const moreMenuRef = useRef<HTMLDivElement>(null);
  const moreBtnRef = useRef<HTMLButtonElement>(null);

  const [soundActive, setSoundActive] = useState(() => pushNotificationService.isSoundEnabled());

  // Live streaming engine status and interval controls
  const [streamActive, setStreamActive] = useState(marketDataService.getIsStreaming());
  const [currentInterval, setCurrentInterval] = useState(marketDataService.getStreamingInterval());
  const [isFetchingState, setIsFetchingState] = useState(marketDataService.getIsFetching());
  const [lastFetchedAt, setLastFetchedAt] = useState<string | null>(marketDataService.getLastFetchedAt());

  useEffect(() => {
    const unsub = marketDataService.subscribeState((state) => {
      setStreamActive(state.isStreaming);
      setCurrentInterval(state.intervalMs);
      setIsFetchingState(state.isFetching);
      setLastFetchedAt(state.lastFetchedAt);
    });
    return () => unsub();
  }, []);

  const handleChangeSpeed = (speedMs: number) => {
    setCurrentInterval(speedMs);
    marketDataService.setStreamingInterval(speedMs);
  };

  const handleToggleStreaming = () => {
    const nextState = !streamActive;
    setStreamActive(nextState);
    marketDataService.setStreaming(nextState);
  };

  const handleForceRefresh = () => {
    marketDataService.fetchRealQuotes(undefined, true);
  };

  const unreadCount = notifications.filter((n) => !n.read).length;

  // Close menus when clicking outside or pressing Escape
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      const target = event.target as Node;

      if (
        notifMenuRef.current &&
        !notifMenuRef.current.contains(target) &&
        notifBtnRef.current &&
        !notifBtnRef.current.contains(target)
      ) {
        setShowNotifMenu(false);
      }

      if (
        settingsMenuRef.current &&
        !settingsMenuRef.current.contains(target) &&
        settingsBtnRef.current &&
        !settingsBtnRef.current.contains(target)
      ) {
        setShowSettingsMenu(false);
      }

      if (
        moreMenuRef.current &&
        !moreMenuRef.current.contains(target) &&
        moreBtnRef.current &&
        !moreBtnRef.current.contains(target)
      ) {
        setShowMoreMenu(false);
      }
    };

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setShowNotifMenu(false);
        setShowSettingsMenu(false);
        setShowMoreMenu(false);
      }
    };

    if (showNotifMenu || showSettingsMenu || showMoreMenu) {
      document.addEventListener('mousedown', handleClickOutside);
      window.addEventListener('keydown', handleKeyDown);
    }
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [showNotifMenu, showSettingsMenu, showMoreMenu]);

  // Hosting (telefon): zakladka silnika nie ma czego pokazac bez serwera.
  const trybHostowany = czyTrybHostowany();
  const navItems = [
    {
      id: 'portfolio',
      label: language === 'pl' ? 'Portfel' : 'Portfolio',
      shortLabel: language === 'pl' ? 'Portfel' : 'Portf.',
      icon: Wallet,
      badge: openPositionsCount > 0 ? openPositionsCount : null,
      isPrimary: true,
    },
    {
      id: 'tax',
      label: 'PIT-38',
      shortLabel: 'PIT-38',
      icon: Calculator,
      badge: null,
    },
    {
      id: 'transactions',
      label: language === 'pl' ? 'Transakcje' : 'Transactions',
      shortLabel: language === 'pl' ? 'Rejestr' : 'History',
      icon: History,
      badge: transactionCount > 0 ? transactionCount : null,
    },
    {
      id: 'brokers',
      label: language === 'pl' ? 'Rachunki' : 'Brokers',
      shortLabel: language === 'pl' ? 'Konta' : 'Brokers',
      icon: Briefcase,
      badge: brokerCount > 0 ? brokerCount : null,
    },
    {
      id: 'charts',
      label: language === 'pl' ? 'Wykresy' : 'Charts',
      shortLabel: language === 'pl' ? 'Wykresy' : 'Live',
      icon: TrendingUp,
      badge: 'LIVE',
      isLive: true,
    },
    {
      id: 'alerts',
      label: language === 'pl' ? 'Alerty' : 'Alerts',
      shortLabel: language === 'pl' ? 'Alerty' : 'Alerts',
      icon: Bell,
      badge: alertCount > 0 ? alertCount : null,
    },
    {
      id: 'engine',
      label: language === 'pl' ? 'Dokumenty i silnik' : 'Documents & engine',
      shortLabel: language === 'pl' ? 'Dokumenty' : 'Docs',
      icon: FileSearch,
      badge: engineFileCount > 0 ? engineFileCount : null,
    },
    {
      id: 'security',
      label: language === 'pl' ? '2FA / Bezpieczeństwo' : 'Security',
      shortLabel: '2FA',
      icon: Shield,
      badge: twoFactor.isEnabled ? (twoFactor.isLocked ? '🔒' : '✓') : null,
    },
  ].filter((item) => !(trybHostowany && item.id === 'engine'));

  return (
    <div className="fixed bottom-0 inset-x-0 z-40">
      {/* Floating Notifications Popover (Opens Upward) */}
      {showNotifMenu && (
        <div
          ref={notifMenuRef}
          id="bottom-notifications-popup"
          className="max-w-md mx-auto mb-2 px-4 max-h-[calc(100dvh-6rem)] overflow-y-auto overscroll-contain animate-in fade-in slide-in-from-bottom-3 duration-200"
        >
          <div className="rounded-2xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 shadow-2xl p-4 overflow-hidden">
            <div className="flex items-center justify-between pb-3 border-b border-slate-100 dark:border-slate-800">
              <div className="flex items-center gap-2">
                <Bell className="w-4 h-4 text-blue-600 dark:text-blue-400" />
                <span className="font-bold text-sm text-slate-900 dark:text-white">
                  {language === 'pl' ? 'Centrum Powiadomień' : 'Notifications Center'}
                </span>
                {unreadCount > 0 && (
                  <span className="px-2 py-0.5 rounded-full text-[10px] font-bold bg-blue-100 dark:bg-blue-900/60 text-blue-700 dark:text-blue-300 font-mono">
                    {unreadCount} {language === 'pl' ? 'nowych' : 'new'}
                  </span>
                )}
              </div>
              <div className="flex items-center gap-2">
                {notifications.length > 0 && (
                  <button
                    onClick={onClearNotifications}
                    className="flex items-center gap-1 text-xs text-slate-500 hover:text-rose-600 dark:hover:text-rose-400 transition-colors cursor-pointer"
                    title={language === 'pl' ? 'Wyczyść wszystkie' : 'Clear all'}
                  >
                    <Trash2 className="w-3 h-3" />
                    <span className="text-[11px]">{language === 'pl' ? 'Wyczyść' : 'Clear'}</span>
                  </button>
                )}
                <button
                  onClick={() => setShowNotifMenu(false)}
                  className="p-1 rounded-lg text-slate-400 hover:text-slate-700 dark:hover:text-slate-200 cursor-pointer"
                >
                  <X className="w-4 h-4" />
                </button>
              </div>
            </div>

            <div className="mt-3 max-h-72 overflow-y-auto space-y-2 pr-1">
              {notifications.length === 0 ? (
                <div className="text-center py-8 text-slate-400">
                  <Bell className="w-6 h-6 mx-auto mb-1.5 opacity-40" />
                  <p className="text-xs">{language === 'pl' ? 'Brak powiadomień' : 'No notifications'}</p>
                </div>
              ) : (
                notifications.map((n) => (
                  <div
                    key={n.id}
                    {...klikalny(() => onMarkNotificationRead(n.id))}
                    className={`p-2.5 rounded-xl border text-xs cursor-pointer transition-all ${
                      n.read
                        ? 'bg-slate-50 dark:bg-slate-800/40 border-slate-100 dark:border-slate-800 text-slate-500'
                        : 'bg-blue-50/80 dark:bg-blue-950/40 border-blue-200 dark:border-blue-800/70 text-slate-800 dark:text-slate-200 shadow-xs'
                    }`}
                  >
                    <div className="flex items-start justify-between gap-2">
                      <span className="font-bold text-slate-900 dark:text-white flex items-center gap-1.5">
                        {!n.read && <span className="w-1.5 h-1.5 rounded-full bg-blue-600 shrink-0" />}
                        {n.title}
                      </span>
                      <span className="text-[10px] text-slate-400 font-mono shrink-0">
                        {new Date(n.timestamp).toLocaleTimeString(language === 'pl' ? 'pl-PL' : 'en-GB', { hour: '2-digit', minute: '2-digit' })}
                      </span>
                    </div>
                    <p className="mt-1 text-slate-600 dark:text-slate-300 text-[11px] leading-relaxed">
                      {n.body}
                    </p>
                  </div>
                ))
              )}
            </div>
          </div>
        </div>
      )}

      {/* Floating Settings Popover (Opens Upward from the 3-lines Menu) */}
      {showSettingsMenu && (
        <div
          ref={settingsMenuRef}
          id="bottom-settings-popup"
          className="max-w-md w-full mx-auto mb-2 px-3 sm:px-4 max-h-[calc(100dvh-6rem)] overflow-y-auto overscroll-contain animate-in fade-in slide-in-from-bottom-3 duration-200"
        >
          <div className="rounded-2xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 shadow-2xl p-4 sm:p-5 overflow-hidden text-slate-900 dark:text-slate-100 space-y-4">
            {/* Header */}
            <div className="flex items-center justify-between pb-3 border-b border-slate-100 dark:border-slate-800">
              <div className="flex items-center gap-2">
                <div className="w-7 h-7 rounded-lg bg-blue-50 dark:bg-blue-950/60 border border-blue-200 dark:border-blue-800/60 flex items-center justify-center text-blue-600 dark:text-blue-400">
                  <SlidersHorizontal className="w-3.5 h-3.5" />
                </div>
                <div>
                  <h3 className="font-bold text-sm text-slate-900 dark:text-white leading-none">
                    {language === 'pl' ? 'Ustawienia Aplikacji' : 'App Settings'}
                  </h3>
                  <p className="text-[10px] text-slate-400 mt-0.5">
                    {language === 'pl' ? 'Częstotliwość danych i preferencje' : 'Data refresh frequency & preferences'}
                  </p>
                </div>
              </div>
              <button
                onClick={() => setShowSettingsMenu(false)}
                className="p-1 rounded-lg text-slate-400 hover:text-slate-700 dark:hover:text-slate-200 cursor-pointer"
                title={language === 'pl' ? 'Zamknij' : 'Close'}
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            {/* Częstotliwość odświeżania danych na żywo (Live Data Stream Controls) */}
            <div className="p-3.5 rounded-xl bg-slate-50 dark:bg-slate-800/60 border border-slate-200 dark:border-slate-700/80 space-y-3">
              {/* Status and Pause/Resume */}
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <span className="relative flex h-2.5 w-2.5">
                    {streamActive && (
                      <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75" />
                    )}
                    <span
                      className={`relative inline-flex rounded-full h-2.5 w-2.5 ${
                        streamActive
                          ? isFetchingState
                            ? 'bg-amber-400'
                            : 'bg-emerald-500'
                          : 'bg-slate-400 dark:bg-slate-600'
                      }`}
                    />
                  </span>
                  <span className="text-xs font-bold text-slate-900 dark:text-white">
                    {streamActive
                      ? isFetchingState
                        ? language === 'pl' ? 'Pobieranie notowań...' : 'Fetching quotes...'
                        : `${language === 'pl' ? 'Odświeżanie na żywo' : 'Live Refresh'} (${(currentInterval / 1000).toFixed(0)}s)`
                      : language === 'pl' ? 'Odświeżanie wstrzymane' : 'Stream Paused'}
                  </span>
                </div>

                <button
                  id="settings-stream-toggle-btn"
                  onClick={handleToggleStreaming}
                  className={`px-2.5 py-1 rounded-lg text-[11px] font-bold flex items-center gap-1 transition-all cursor-pointer ${
                    streamActive
                      ? 'bg-amber-500/10 text-amber-600 dark:text-amber-400 hover:bg-amber-500/20 border border-amber-500/30'
                      : 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 hover:bg-emerald-500/20 border border-emerald-500/30'
                  }`}
                  title={streamActive ? 'Wstrzymaj automatyczne odświeżanie' : 'Wznów automatyczne odświeżanie'}
                >
                  {streamActive ? <Pause className="w-3 h-3" /> : <Play className="w-3 h-3" />}
                  <span>{streamActive ? (language === 'pl' ? 'Wstrzymaj' : 'Pause') : (language === 'pl' ? 'Wznów' : 'Resume')}</span>
                </button>
              </div>

              {/* Frequency Selector Buttons */}
              <div>
                <label className="block text-[11px] font-medium text-slate-500 dark:text-slate-400 mb-1.5">
                  {language === 'pl' ? 'Częstotliwość odświeżania wycen giełdowych:' : 'Quote refresh interval:'}
                </label>
                <div className="grid grid-cols-5 gap-1.5">
                  {STREAM_SPEED_OPTIONS.map((opt) => {
                    const isSelected = currentInterval === opt.value;
                    return (
                      <button
                        key={opt.value}
                        id={`settings-stream-speed-${opt.shortLabel}`}
                        onClick={() => handleChangeSpeed(opt.value)}
                        className={`py-1.5 px-1 rounded-lg text-xs font-bold text-center transition-all cursor-pointer font-mono ${
                          isSelected
                            ? 'bg-blue-600 text-white shadow-sm ring-2 ring-blue-500/40'
                            : 'bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 text-slate-700 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800'
                        }`}
                        title={opt.description}
                      >
                        {opt.shortLabel}
                      </button>
                    );
                  })}
                </div>
              </div>

              {/* Timestamp & Refresh Button */}
              <div className="flex items-center justify-between pt-2 text-[11px] text-slate-500 dark:text-slate-400 border-t border-slate-200/60 dark:border-slate-700/60">
                <div className="flex items-center gap-1 font-mono text-[10px]">
                  <Clock className="w-3 h-3 text-slate-400 shrink-0" />
                  <span>
                    {lastFetchedAt
                      ? `${language === 'pl' ? 'Aktualizacja' : 'Updated'}: ${new Date(lastFetchedAt).toLocaleTimeString(language === 'pl' ? 'pl-PL' : 'en-GB', { hour: '2-digit', minute: '2-digit', second: '2-digit' })}`
                      : language === 'pl' ? 'Oczekiwanie...' : 'Waiting...'}
                  </span>
                </div>
                <button
                  id="settings-force-refresh-btn"
                  onClick={handleForceRefresh}
                  disabled={isFetchingState}
                  className="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg bg-blue-50 dark:bg-blue-950/60 text-blue-600 dark:text-blue-400 hover:bg-blue-100 dark:hover:bg-blue-900/60 font-semibold text-xs cursor-pointer transition-colors disabled:opacity-50"
                  title="Wymuś natychmiastowe pobranie najświeższych wycen"
                >
                  <RefreshCw className={`w-3 h-3 ${isFetchingState ? 'animate-spin' : ''}`} />
                  <span>{language === 'pl' ? 'Odśwież teraz' : 'Refresh now'}</span>
                </button>
              </div>
            </div>

            {/* Quick Preferences: Language, Theme, Sound & 2FA */}
            <div className="grid grid-cols-2 gap-2 pt-1">
              {/* Language Switch */}
              <button
                id="settings-lang-toggle-btn"
                onClick={() => setLanguage(language === 'pl' ? 'en' : 'pl')}
                className="p-2.5 rounded-xl bg-slate-50 dark:bg-slate-800/40 border border-slate-200 dark:border-slate-700/60 hover:bg-slate-100 dark:hover:bg-slate-800 flex items-center justify-between text-left transition-colors cursor-pointer"
              >
                <div className="flex items-center gap-2">
                  <Globe className="w-3.5 h-3.5 text-blue-500" />
                  <span className="text-xs font-semibold">{language === 'pl' ? 'Język' : 'Language'}</span>
                </div>
                <span className="text-xs font-bold text-blue-600 dark:text-blue-400 uppercase font-mono">
                  {language.toUpperCase()}
                </span>
              </button>

              {/* Theme Switch (Dark / Light) */}
              <button
                id="settings-theme-toggle-btn"
                onClick={() => {
                  if (setTheme) {
                    setTheme(theme === 'dark' ? 'light' : 'dark');
                  }
                }}
                className="p-2.5 rounded-xl bg-slate-50 dark:bg-slate-800/40 border border-slate-200 dark:border-slate-700/60 hover:bg-slate-100 dark:hover:bg-slate-800 flex items-center justify-between text-left transition-colors cursor-pointer"
                title={language === 'pl' ? 'Przełącz motyw (Ciemny / Jasny)' : 'Toggle Theme'}
              >
                <div className="flex items-center gap-2">
                  {theme === 'dark' ? (
                    <Moon className="w-3.5 h-3.5 text-indigo-400" />
                  ) : (
                    <Sun className="w-3.5 h-3.5 text-amber-500" />
                  )}
                  <span className="text-xs font-semibold">{language === 'pl' ? 'Motyw' : 'Theme'}</span>
                </div>
                <span className="text-[11px] font-bold font-mono text-slate-700 dark:text-slate-300 uppercase">
                  {theme === 'dark' ? (language === 'pl' ? 'Ciemny' : 'Dark') : (language === 'pl' ? 'Jasny' : 'Light')}
                </span>
              </button>

              {/* Sound Alerts Switch */}
              <button
                id="settings-sound-toggle-btn"
                onClick={() => {
                  const nextState = !soundActive;
                  setSoundActive(nextState);
                  pushNotificationService.setSoundEnabled(nextState);
                }}
                className="p-2.5 rounded-xl bg-slate-50 dark:bg-slate-800/40 border border-slate-200 dark:border-slate-700/60 hover:bg-slate-100 dark:hover:bg-slate-800 flex items-center justify-between text-left transition-colors cursor-pointer"
                title={language === 'pl' ? 'Dźwięki powiadomień i alertów' : 'Notification sounds'}
              >
                <div className="flex items-center gap-2">
                  {soundActive ? (
                    <Volume2 className="w-3.5 h-3.5 text-emerald-500" />
                  ) : (
                    <VolumeX className="w-3.5 h-3.5 text-slate-400" />
                  )}
                  <span className="text-xs font-semibold">{language === 'pl' ? 'Dźwięk' : 'Sound'}</span>
                </div>
                <span className={`text-[11px] font-bold font-mono ${soundActive ? 'text-emerald-500' : 'text-slate-400'}`}>
                  {soundActive ? 'ON' : 'OFF'}
                </span>
              </button>

              {/* 2FA Quick Lock */}
              <button
                id="settings-2fa-toggle-btn"
                onClick={() => {
                  if (twoFactor.isEnabled) {
                    if (twoFactor.isLocked) onUnlockModalOpen();
                    else onLockSession();
                  } else {
                    setActiveTab('security');
                    setShowSettingsMenu(false);
                  }
                }}
                className="p-2.5 rounded-xl bg-slate-50 dark:bg-slate-800/40 border border-slate-200 dark:border-slate-700/60 hover:bg-slate-100 dark:hover:bg-slate-800 flex items-center justify-between text-left transition-colors cursor-pointer"
              >
                <div className="flex items-center gap-2">
                  <Shield className="w-3.5 h-3.5 text-emerald-500" />
                  <span className="text-xs font-semibold">2FA TOTP</span>
                </div>
                <span className={`text-[11px] font-bold font-mono ${twoFactor.isEnabled ? (twoFactor.isLocked ? 'text-amber-500' : 'text-emerald-500') : 'text-slate-400'}`}>
                  {twoFactor.isEnabled ? (twoFactor.isLocked ? 'LOCKED' : 'ACTIVE') : 'OFF'}
                </span>
              </button>
            </div>
          </div>
        </div>
      )}

      {showMoreMenu && (
        <div ref={moreMenuRef} className="max-w-sm mx-auto mb-2 px-3 lg:hidden animate-in fade-in slide-in-from-bottom-3 duration-200">
          <Suspense fallback={null}>
            <MoreNavMenu items={navItems.slice(3)} activeTab={activeTab} language={language} onSelect={(id) => {
              setActiveTab(id);
              setShowMoreMenu(false);
              setShowNotifMenu(false);
              setShowSettingsMenu(false);
            }} />
          </Suspense>
        </div>
      )}

      {/* Main Navigation Bar */}
      <nav
        id="bottom-navigation-bar"
        aria-label="Główna nawigacja dolna"
        className="w-full pb-[env(safe-area-inset-bottom)] bg-white/95 dark:bg-slate-900/95 backdrop-blur-xl border-t border-slate-200/90 dark:border-slate-800/90 shadow-[0_-4px_20px_rgba(15,23,42,0.06)] dark:shadow-[0_-4px_20px_rgba(0,0,0,0.28)] transition-colors duration-200"
      >
        <div className="max-w-7xl mx-auto px-2 sm:px-4">
          <div className="flex items-center justify-between h-16 sm:h-18 gap-1 sm:gap-2">
            {/* Primary Tab Navigation Buttons */}
            <div className="flex items-center justify-around flex-1 gap-0.5 sm:gap-1">
              {navItems.map((item) => {
                const Icon = item.icon;
                const isActive = activeTab === item.id;

                return (
                  <button
                    key={item.id}
                    id={`bottom-nav-btn-${item.id}`}
                     onClick={() => {
                       setActiveTab(item.id);
                       setShowNotifMenu(false);
                       setShowSettingsMenu(false);
                       setShowMoreMenu(false);
                     }}
                    className={`relative ${navItems.indexOf(item) >= 3 ? 'hidden lg:flex' : 'flex'} flex-col items-center justify-center flex-1 h-full py-1.5 px-1 sm:px-2 rounded-xl transition-all duration-150 group cursor-pointer focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 ${
                      isActive
                        ? 'text-blue-600 dark:text-blue-400 font-bold'
                        : 'text-slate-500 dark:text-slate-400 hover:text-slate-800 dark:hover:text-slate-200 hover:bg-slate-100/60 dark:hover:bg-slate-800/40 font-medium'
                    }`}
                    title={item.label}
                  >
                    {/* Top active indicator line */}
                    {isActive && (
                      <span className="absolute top-0 inset-x-2 sm:inset-x-4 h-0.5 bg-blue-600 dark:bg-blue-400 rounded-full" />
                    )}

                    {/* Icon Container with Badge */}
                    <div className="relative flex items-center justify-center">
                      <div
                        className={`p-1.5 rounded-lg transition-transform duration-150 group-active:scale-95 ${
                          isActive
                            ? 'bg-blue-100/80 dark:bg-blue-900/40 text-blue-600 dark:text-blue-400'
                            : 'text-slate-500 dark:text-slate-400 group-hover:text-slate-700 dark:group-hover:text-slate-200'
                        }`}
                      >
                        <Icon className="w-4 h-4 sm:w-5 sm:h-5" />
                      </div>

                      {/* Badge */}
                      {item.badge !== null && (
                        <span
                          className={`absolute -top-1 -right-2 min-w-4 h-4 px-1 rounded-full text-[9px] font-bold flex items-center justify-center font-mono shadow-xs ${
                            item.isLive
                              ? 'bg-emerald-700 text-white animate-pulse text-[8px]'
                              : isActive
                              ? 'bg-blue-600 text-white'
                              : 'bg-slate-200 dark:bg-slate-700 text-slate-700 dark:text-slate-300'
                          }`}
                        >
                          {item.badge}
                        </span>
                      )}
                    </div>

                    {/* Label text */}
                    <span className="text-[10px] sm:text-xs tracking-tight mt-0.5 truncate max-w-full text-center leading-none">
                      <span className="hidden md:inline">{item.label}</span>
                      <span className="md:hidden">{item.shortLabel}</span>
                    </span>
                  </button>
                );
              })}
              <button
                ref={moreBtnRef}
                id="bottom-nav-more-btn"
                aria-haspopup="menu"
                aria-expanded={showMoreMenu}
                aria-controls="bottom-nav-more-menu"
                onClick={() => {
                  setShowMoreMenu((previous) => !previous);
                  setShowNotifMenu(false);
                  setShowSettingsMenu(false);
                }}
                className={`relative flex lg:hidden flex-col items-center justify-center flex-1 h-full py-1.5 px-1 rounded-xl transition-all duration-150 cursor-pointer focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 ${showMoreMenu || navItems.slice(3).some((item) => item.id === activeTab) ? 'text-blue-600 dark:text-blue-400 font-bold' : 'text-slate-500 dark:text-slate-400 hover:bg-slate-100/60 dark:hover:bg-slate-800/40'}`}
              >
                <MoreHorizontal className="w-5 h-5" />
                <span className="text-[10px] tracking-tight mt-0.5 leading-none">{language === 'pl' ? 'Więcej' : 'More'}</span>
              </button>
            </div>

            {/* Utility & Action Controls Cluster on the right */}
            <div className="flex items-center gap-1 sm:gap-2 pl-2 sm:pl-3 border-l border-slate-200 dark:border-slate-800 shrink-0">
              {/* Notifications Button */}
              <button
                ref={notifBtnRef}
                id="bottom-nav-notif-btn"
                onClick={() => {
                  setShowNotifMenu((prev) => {
                    if (!prev) setShowSettingsMenu(false);
                    return !prev;
                  });
                }}
                className={`p-2 min-h-10 min-w-10 inline-flex items-center justify-center rounded-xl text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors relative cursor-pointer ${
                  showNotifMenu ? 'bg-blue-50 dark:bg-blue-950 text-blue-600 dark:text-blue-400' : ''
                }`}
                title={language === 'pl' ? 'Powiadomienia i alerty' : 'Notifications & Alerts'}
                // Etykieta zastepuje tresc przycisku, wiec liczba nieprzeczytanych
                // musi byc w niej - inaczej czytnik ekranu jej nie podawal.
                aria-label={`${language === 'pl' ? 'Powiadomienia' : 'Notifications'}${
                  unreadCount > 0 ? `, ${language === 'pl' ? 'nieprzeczytane' : 'unread'}: ${unreadCount}` : ''
                }`}
                aria-expanded={showNotifMenu}
              >
                <Bell className="w-4 h-4 sm:w-4.5 sm:h-4.5" />
                {unreadCount > 0 && (
                  <span aria-hidden="true" className="absolute top-1 right-1 flex h-3.5 min-w-3.5 px-0.5 items-center justify-center rounded-full bg-rose-600 text-[9px] font-bold text-white shadow-xs">
                    {unreadCount > 9 ? '9+' : unreadCount}
                  </span>
                )}
              </button>

              {/* 2FA Lock Button (if enabled) */}
              {twoFactor.isEnabled && (
                <button
                  id="bottom-nav-2fa-btn"
                  onClick={twoFactor.isLocked ? onUnlockModalOpen : onLockSession}
                  title={
                    twoFactor.isLocked
                      ? 'Sesja zablokowana 2FA - kliknij aby odblokować'
                      : 'Zablokuj sesję (2FA TOTP)'
                  }
                  className={`p-2 min-h-10 min-w-10 inline-flex items-center justify-center rounded-xl text-xs font-semibold flex items-center gap-1 border transition-all cursor-pointer ${
                    twoFactor.isLocked
                      ? 'bg-rose-50 dark:bg-rose-950/50 border-rose-200 dark:border-rose-800 text-rose-600 dark:text-rose-400'
                      : 'bg-emerald-50 dark:bg-emerald-950/50 border-emerald-200 dark:border-emerald-800 text-emerald-600 dark:text-emerald-400'
                  }`}
                >
                  {twoFactor.isLocked ? <Lock className="w-3.5 h-3.5" /> : <Unlock className="w-3.5 h-3.5" />}
                  <span className="hidden lg:inline text-[11px] font-mono">
                    {twoFactor.isLocked ? 'LOCKED' : '2FA'}
                  </span>
                </button>
              )}

              {/* Language Switcher */}
              <button
                id="bottom-nav-lang-btn"
                onClick={() => setLanguage(language === 'pl' ? 'en' : 'pl')}
                className="px-2 py-1.5 rounded-xl text-slate-700 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800 text-xs font-bold uppercase flex items-center gap-1 transition-colors cursor-pointer border border-transparent hover:border-slate-200 dark:hover:border-slate-700"
                title={language === 'pl' ? 'Zmień język na English' : 'Switch to Polish'}
              >
                <Globe className="w-3.5 h-3.5 text-slate-500" />
                <span className="text-[11px]">{language.toUpperCase()}</span>
              </button>

              {/* 3-Lines (Hamburger Menu) Settings Button */}
              <button
                ref={settingsBtnRef}
                id="bottom-nav-settings-btn"
                onClick={() => {
                  setShowSettingsMenu((prev) => {
                    if (!prev) setShowNotifMenu(false);
                    return !prev;
                  });
                }}
                className={`p-2 min-h-10 min-w-10 inline-flex items-center justify-center rounded-xl text-slate-700 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors relative cursor-pointer border border-transparent hover:border-slate-200 dark:hover:border-slate-700 ${
                  showSettingsMenu ? 'bg-blue-50 dark:bg-blue-950 text-blue-600 dark:text-blue-400 border-blue-200 dark:border-blue-800' : ''
                }`}
                title={language === 'pl' ? 'Ustawienia i częstotliwość odświeżania danych' : 'Settings & Data Refresh Frequency'}
                aria-label="Ustawienia"
              >
                <Menu className="w-4 h-4 sm:w-4.5 sm:h-4.5" />
              </button>
            </div>
          </div>
        </div>
      </nav>
    </div>
  );
};
