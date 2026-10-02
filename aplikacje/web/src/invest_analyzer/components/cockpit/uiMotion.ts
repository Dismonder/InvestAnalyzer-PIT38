import { useReducedMotion } from 'motion/react';

export function useUiMotion() {
  const prefersReducedMotion = Boolean(useReducedMotion());
  const transition = (delay = 0, duration = 0.32) => (
    prefersReducedMotion ? { duration: 0 } : { duration, delay }
  );
  const fadeUp = (delay = 0) => ({
    initial: prefersReducedMotion ? false : { opacity: 0, y: 18, scale: 0.98 },
    animate: { opacity: 1, y: 0, scale: 1 },
    transition: transition(delay),
  });
  const fadeIn = (delay = 0) => ({
    initial: prefersReducedMotion ? false : { opacity: 0 },
    animate: { opacity: 1 },
    transition: transition(delay, 0.24),
  });
  const drawerPanel = {
    initial: prefersReducedMotion ? false : { opacity: 0, x: 42 },
    animate: { opacity: 1, x: 0 },
    exit: prefersReducedMotion ? { opacity: 0 } : { opacity: 0, x: 42 },
    transition: transition(0, 0.26),
  };
  const collapseReveal = {
    initial: prefersReducedMotion ? false : { opacity: 0, height: 0, y: -8 },
    animate: { opacity: 1, height: 'auto', y: 0 },
    exit: prefersReducedMotion ? { opacity: 0 } : { opacity: 0, height: 0, y: -8 },
    transition: transition(0, 0.22),
  };

  return {
    prefersReducedMotion,
    transition,
    fadeUp,
    fadeIn,
    drawerPanel,
    collapseReveal,
    hoverLift: prefersReducedMotion ? undefined : { y: -3, scale: 1.01 },
    hoverPop: prefersReducedMotion ? undefined : { y: -2, scale: 1.02 },
    hoverSpin: prefersReducedMotion ? undefined : { rotate: 90, scale: 1.06 },
    tapPress: prefersReducedMotion ? undefined : { scale: 0.98 },
  };
}
