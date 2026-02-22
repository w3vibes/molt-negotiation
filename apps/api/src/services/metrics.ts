export interface Metric {
  route: string;
  method: string;
  statusCode: number;
  durationMs: number;
  timestamp: number;
}

class MetricsService {
  private metrics: Metric[] = [];
  private maxMetrics = 1000;

  observe(data: Omit<Metric, 'timestamp'>): void {
    this.metrics.push({ ...data, timestamp: Date.now() });
    
    if (this.metrics.length > this.maxMetrics) {
      this.metrics = this.metrics.slice(-this.maxMetrics);
    }
  }

  snapshot() {
    const now = Date.now();
    const last5min = this.metrics.filter(m => now - m.timestamp < 5 * 60 * 1000);
    
    const byRoute = new Map<string, { count: number; totalDuration: number; errors: number }>();
    
    for (const m of last5min) {
      const key = `${m.method} ${m.route}`;
      const existing = byRoute.get(key) || { count: 0, totalDuration: 0, errors: 0 };
      existing.count++;
      existing.totalDuration += m.durationMs;
      if (m.statusCode >= 400) existing.errors++;
      byRoute.set(key, existing);
    }

    const routes: Record<string, { count: number; avgDurationMs: number; errorRate: number }> = {};
    for (const [key, val] of byRoute) {
      routes[key] = {
        count: val.count,
        avgDurationMs: val.totalDuration / val.count,
        errorRate: val.errors / val.count
      };
    }

    return {
      totalRequests: last5min.length,
      routes,
      windowMs: 5 * 60 * 1000
    };
  }

  reset(): void {
    this.metrics = [];
  }
}

export const metrics = new MetricsService();
