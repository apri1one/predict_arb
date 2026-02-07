import { useEffect, useState } from "react";
import { ClosePositionCard } from "./ClosePositionCard";
import { Card, CardContent, CardHeader, CardTitle } from "./ui/card";
import { Button } from "./ui/button";

function getAuthHeaders(): Record<string, string> {
  if (typeof window === 'undefined') return {};
  const token = localStorage.getItem('dashboardApiToken') || localStorage.getItem('DASHBOARD_API_TOKEN');
  return token ? { Authorization: `Bearer ${token}` } : {};
}

interface CloseOpportunity {
  polymarketConditionId: string;
  predictMarketId: number;
  title: string;
  arbSide: 'YES' | 'NO';
  matchedShares: number;
  maxCloseShares: number;
  polymarketNoTokenId?: string;
  polymarketYesTokenId?: string;
  negRisk?: boolean;
  tickSize?: number;
  isInverted?: boolean;
  tt: {
    predictBid: number;
    predictBidDepth: number;
    polyBid: number;
    polyBidDepth: number;
    predictFee: number;
    estProfitPerShare: number;
    estProfitTotal: number;
    estProfitPct: number;
    minPolyBid: number;
    isValid: boolean;
  };
  mt: {
    predictAsk: number;
    polyBid: number;
    polyBidDepth: number;
    estProfitPerShare: number;
    estProfitTotal: number;
    estProfitPct: number;
    minPolyBid: number;
    isValid: boolean;
  };
  feeRateBps: number;
  entryCostPerShare: number;
  lastUpdate: number;
}

interface UnmatchedPosition {
  platform: 'predict' | 'polymarket';
  marketId?: number;
  conditionId?: string;
  tokenId?: string;
  title: string;
  side: 'YES' | 'NO';
  shares: number;
  avgPrice: number;
  reason: 'no_mapping' | 'no_counterpart' | 'direction_mismatch';
}

interface ClosePositionListProps {
  apiBase?: string;
}

const REASON_LABELS: Record<string, string> = {
  no_mapping: 'No Mapping',
  no_counterpart: 'No Hedge',
  direction_mismatch: 'Direction Mismatch',
};

export function ClosePositionList({ apiBase = '' }: ClosePositionListProps) {
  const [opportunities, setOpportunities] = useState<CloseOpportunity[]>([]);
  const [unmatchedPositions, setUnmatchedPositions] = useState<UnmatchedPosition[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [lastRefresh, setLastRefresh] = useState<Date | null>(null);
  const [showUnmatched, setShowUnmatched] = useState(true);

  const fetchOpportunities = async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`${apiBase}/api/close-opportunities`, {
        headers: { ...getAuthHeaders() },
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      setOpportunities(data.opportunities || []);
      setUnmatchedPositions(data.unmatchedPositions || []);
      setLastRefresh(new Date());
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchOpportunities();
    // 每 30 秒自动刷新
    const interval = setInterval(fetchOpportunities, 30000);
    return () => clearInterval(interval);
  }, [apiBase]);

  const handleSuccess = () => {
    // Refresh after successful task creation
    fetchOpportunities();
  };

  const profitableCount = opportunities.filter(o => o.tt.isValid || o.mt.isValid).length;
  const totalPotentialProfit = opportunities.reduce((sum, o) =>
    sum + Math.max(o.tt.estProfitTotal, o.mt.estProfitTotal), 0
  );

  // 分离 Predict 和 Polymarket 未匹配持仓
  const unmatchedPredict = unmatchedPositions.filter(p => p.platform === 'predict');
  const unmatchedPoly = unmatchedPositions.filter(p => p.platform === 'polymarket');

  return (
    <div className="space-y-4">
      {/* 统计摘要 */}
      <Card>
        <CardHeader className="pb-2">
          <div className="flex items-center justify-between">
            <CardTitle className="text-lg">Close Position</CardTitle>
            <Button variant="outline" size="sm" onClick={fetchOpportunities} disabled={loading}>
              {loading ? 'Loading...' : 'Refresh'}
            </Button>
          </div>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-5 gap-4 text-sm">
            <div>
              <div className="text-muted-foreground">Matched</div>
              <div className="text-2xl font-bold">{opportunities.length}</div>
            </div>
            <div>
              <div className="text-muted-foreground">Profitable</div>
              <div className="text-2xl font-bold text-green-500">{profitableCount}</div>
            </div>
            <div>
              <div className="text-muted-foreground">Est. Profit</div>
              <div className={`text-2xl font-bold ${totalPotentialProfit >= 0 ? 'text-green-500' : 'text-red-500'}`}>
                {totalPotentialProfit >= 0 ? '+' : ''}${totalPotentialProfit.toFixed(2)}
              </div>
            </div>
            <div>
              <div className="text-muted-foreground">Unmatched</div>
              <div className="text-2xl font-bold text-yellow-500">{unmatchedPositions.length}</div>
            </div>
            <div>
              <div className="text-muted-foreground">Last Update</div>
              <div className="text-sm font-mono">
                {lastRefresh ? lastRefresh.toLocaleTimeString() : '-'}
              </div>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* 错误提示 */}
      {error && (
        <Card className="border-red-500">
          <CardContent className="py-4">
            <p className="text-red-500">Load failed: {error}</p>
          </CardContent>
        </Card>
      )}

      {/* 匹配的双腿持仓 */}
      {opportunities.length === 0 && !loading && !error ? (
        <Card>
          <CardContent className="py-8 text-center text-muted-foreground">
            No matched positions to close
          </CardContent>
        </Card>
      ) : (
        <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
          {opportunities.map((opp) => (
            <ClosePositionCard
              key={`${opp.predictMarketId}-${opp.arbSide}`}
              opportunity={opp}
              apiBase={apiBase}
              onTaskCreated={handleSuccess}
            />
          ))}
        </div>
      )}

      {/* 未匹配的单腿持仓 */}
      {unmatchedPositions.length > 0 && (
        <Card>
          <CardHeader className="pb-2">
            <div className="flex items-center justify-between">
              <CardTitle className="text-lg text-yellow-500">
                Unmatched Positions ({unmatchedPositions.length})
              </CardTitle>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setShowUnmatched(!showUnmatched)}
              >
                {showUnmatched ? 'Hide' : 'Show'}
              </Button>
            </div>
          </CardHeader>
          {showUnmatched && (
            <CardContent>
              <div className="space-y-4">
                {/* Predict 单腿 */}
                {unmatchedPredict.length > 0 && (
                  <div>
                    <h4 className="text-sm font-semibold text-blue-400 mb-2">
                      Predict ({unmatchedPredict.length})
                    </h4>
                    <div className="space-y-2">
                      {unmatchedPredict.map((pos, idx) => (
                        <div
                          key={`predict-${pos.marketId}-${pos.side}-${idx}`}
                          className="flex items-center justify-between p-2 bg-muted/50 rounded text-sm"
                        >
                          <div className="flex-1 min-w-0">
                            <div className="font-medium truncate" title={pos.title}>
                              #{pos.marketId} {pos.title}
                            </div>
                            <div className="text-xs text-muted-foreground">
                              {pos.side} | {pos.shares.toFixed(2)} @ {(pos.avgPrice * 100).toFixed(1)}¢
                            </div>
                          </div>
                          <span className="ml-2 px-2 py-0.5 text-xs bg-yellow-500/20 text-yellow-500 rounded">
                            {REASON_LABELS[pos.reason] || pos.reason}
                          </span>
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {/* Polymarket 单腿 */}
                {unmatchedPoly.length > 0 && (
                  <div>
                    <h4 className="text-sm font-semibold text-purple-400 mb-2">
                      Polymarket ({unmatchedPoly.length})
                    </h4>
                    <div className="space-y-2">
                      {unmatchedPoly.map((pos, idx) => (
                        <div
                          key={`poly-${pos.conditionId}-${pos.side}-${idx}`}
                          className="flex items-center justify-between p-2 bg-muted/50 rounded text-sm"
                        >
                          <div className="flex-1 min-w-0">
                            <div className="font-medium truncate" title={pos.title}>
                              {pos.title}
                            </div>
                            <div className="text-xs text-muted-foreground">
                              {pos.side} | {pos.shares.toFixed(2)} @ {(pos.avgPrice * 100).toFixed(1)}¢
                            </div>
                          </div>
                          <span className="ml-2 px-2 py-0.5 text-xs bg-yellow-500/20 text-yellow-500 rounded">
                            {REASON_LABELS[pos.reason] || pos.reason}
                          </span>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            </CardContent>
          )}
        </Card>
      )}
    </div>
  );
}
