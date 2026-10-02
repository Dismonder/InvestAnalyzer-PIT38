export const DEFAULT_MAX_DASHBOARD_CHART_POINTS = 420;

// Rzadzenie serii dziala na dowolnym punkcie, wiec ten sam kod obsluguje
// zarowno stare salda dzienne, jak i saldo wplat liczone z historii silnika.
export function downsampleDailyBalancesForChart<T>(
  points: T[],
  maxPoints = DEFAULT_MAX_DASHBOARD_CHART_POINTS,
): T[] {
  if (points.length <= maxPoints) {
    return points;
  }

  if (maxPoints <= 0) {
    return [];
  }

  if (maxPoints === 1) {
    return [points[points.length - 1]];
  }

  const lastIndex = points.length - 1;
  const step = lastIndex / (maxPoints - 1);
  const sampled: T[] = [];
  let previousIndex = -1;

  for (let index = 0; index < maxPoints; index += 1) {
    const sourceIndex = index === maxPoints - 1 ? lastIndex : Math.round(index * step);
    if (sourceIndex !== previousIndex) {
      sampled.push(points[sourceIndex]);
      previousIndex = sourceIndex;
    }
  }

  return sampled;
}
