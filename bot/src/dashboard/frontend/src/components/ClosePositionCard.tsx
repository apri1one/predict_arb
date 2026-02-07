import { useState, useEffect, useRef } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "./ui/card";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";

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

interface ClosePositionCardProps {
  opportunity: CloseOpportunity;
  apiBase?: string;
  onClose?: (opp: CloseOpportunity, mode: 'TT' | 'MT') => void;
  onTaskCreated?: () => void;
}

function getAuthHeaders(): Record<string, string> {
  if (typeof window === 'undefined') return {};
  const token = localStorage.getItem('dashboardApiToken') || localStorage.getItem('DASHBOARD_API_TOKEN');
  return token ? { Authorization: `Bearer ${token}` } : {};
}

export function ClosePositionCard({ opportunity, apiBase = '', onClose, onTaskCreated }: ClosePositionCardProps) {
  const [expanded, setExpanded] = useState(false);
  const [ttConfirming, setTtConfirming] = useState(false);
  const [ttSubmitting, setTtSubmitting] = useState(false);
  const [ttError, setTtError] = useState<string | null>(null);
  const [ttQuantity, setTtQuantity] = useState(() => opportunity.matchedShares);
  const ttTimeoutRef = useRef<number | null>(null);
  const { tt, mt } = opportunity;

  // 3 秒后重置 T-T 确认状态
  useEffect(() => {
    if (ttConfirming && !ttSubmitting) {
      ttTimeoutRef.current = window.setTimeout(() => {
        setTtConfirming(false);
      }, 3000);
    }
    return () => {
      if (ttTimeoutRef.current) {
        clearTimeout(ttTimeoutRef.current);
      }
    };
  }, [ttConfirming, ttSubmitting]);

  useEffect(() => {
    setTtQuantity(opportunity.matchedShares);
  }, [opportunity.matchedShares]);

  // T-T 直接提交任务
  const handleTtClick = async () => {
    if (ttSubmitting) return;

    if (ttConfirming) {
      // 第二次点击：直接提交任务
      setTtSubmitting(true);
      setTtError(null);

      try {
        const maxQty = opportunity.maxCloseShares;
        const qty = ttQuantity;
        if (!Number.isFinite(qty) || qty <= 0) {
          throw new Error('Invalid shares');
        }
        if (ttQuantity > maxQty) {
          throw new Error(`Shares exceed max (${maxQty.toFixed(1)})`);
        }

        const payload = {
          type: 'SELL',
          marketId: opportunity.predictMarketId,
          title: opportunity.title,
          polymarketConditionId: opportunity.polymarketConditionId,
          polymarketNoTokenId: opportunity.polymarketNoTokenId || '',
          polymarketYesTokenId: opportunity.polymarketYesTokenId || '',
          isInverted: opportunity.isInverted || false,
          tickSize: opportunity.tickSize || 0.01,
          negRisk: opportunity.negRisk || false,
          arbSide: opportunity.arbSide,
          quantity: qty,
          entryCost: opportunity.entryCostPerShare * qty,
          feeRateBps: opportunity.feeRateBps,
          polymarketMinBid: tt.minPolyBid,
          strategy: 'TAKER',
          predictPrice: tt.predictBid,
          polymarketMaxAsk: 0,
          minProfitBuffer: 0.001,
          orderTimeout: 300000,
          maxHedgeRetries: 3,
        };

        const res = await fetch(`${apiBase}/api/tasks`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...getAuthHeaders() },
          body: JSON.stringify(payload),
        });

        if (!res.ok) {
          const errData = await res.json().catch(() => ({ message: `HTTP ${res.status}` }));
          throw new Error(errData.message || errData.error || `HTTP ${res.status}`);
        }

        const result = await res.json();
        console.log('T-T close task created:', result);
        setTtConfirming(false);
        onTaskCreated?.();
      } catch (e) {
        setTtError((e as Error).message);
      } finally {
        setTtSubmitting(false);
      }
    } else {
      // 第一次点击：进入确认状态
      setTtConfirming(true);
      setTtError(null);
    }
  };

  const formatPrice = (p: number) => (p * 100).toFixed(1) + '¢';
  const formatProfit = (p: number) => p >= 0 ? `+$${p.toFixed(2)}` : `-$${Math.abs(p).toFixed(2)}`;
  const formatPct = (p: number) => p >= 0 ? `+${p.toFixed(1)}%` : `${p.toFixed(1)}%`;

  const bestMode = tt.estProfitTotal >= mt.estProfitTotal ? 'TT' : 'MT';
  const bestProfit = Math.max(tt.estProfitTotal, mt.estProfitTotal);
  const isProfitable = bestProfit > 0;

  return (
    <Card className={`transition-all ${isProfitable ? 'border-green-500/50' : 'border-red-500/30'}`}>
      <CardHeader className="pb-2">
        <div className="flex items-start justify-between gap-2">
          <CardTitle className="text-sm font-medium leading-tight line-clamp-2">
            {opportunity.title}
          </CardTitle>
          <div className="flex gap-1 shrink-0">
            <Badge variant={opportunity.arbSide === 'YES' ? 'default' : 'secondary'}>
              {opportunity.arbSide}
            </Badge>
            <Badge variant={isProfitable ? 'default' : 'destructive'}>
              {isProfitable ? 'PROFIT' : 'LOSS'}
            </Badge>
          </div>
        </div>
      </CardHeader>

      <CardContent className="space-y-3">
        {/* Position summary */}
        <div className="grid grid-cols-3 gap-2 text-xs">
          <div>
            <div className="text-muted-foreground">Position</div>
            <div className="font-mono">{opportunity.matchedShares.toFixed(1)} shares</div>
          </div>
          <div>
            <div className="text-muted-foreground">Cost</div>
            <div className="font-mono">{formatPrice(opportunity.entryCostPerShare)}/share</div>
          </div>
          <div>
            <div className="text-muted-foreground">Best Profit</div>
            <div className={`font-mono ${isProfitable ? 'text-green-500' : 'text-red-500'}`}>
              {formatProfit(bestProfit)}
            </div>
          </div>
        </div>

        {/* T-T vs M-T comparison */}
        <div className="grid grid-cols-2 gap-2">
          {/* T-T Mode */}
          <div className={`p-2 rounded border ${tt.isValid ? 'border-green-500/30 bg-green-500/5' : 'border-red-500/30 bg-red-500/5'}`}>
            <div className="flex items-center justify-between mb-1">
              <span className="text-xs font-medium">T-T (Taker)</span>
              {bestMode === 'TT' && <Badge variant="outline" className="text-xs">Best</Badge>}
            </div>
            <div className="space-y-1 text-xs">
              <div className="flex justify-between">
                <span className="text-muted-foreground">Predict Bid</span>
                <span className="font-mono">{formatPrice(tt.predictBid)}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-muted-foreground">Poly Bid</span>
                <span className="font-mono">{formatPrice(tt.polyBid)}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-muted-foreground">Fee</span>
                <span className="font-mono text-red-400">-{formatPrice(tt.predictFee)}</span>
              </div>
              <div className={`flex justify-between font-medium ${tt.isValid ? 'text-green-500' : 'text-red-500'}`}>
                <span>Profit</span>
                <span>{formatProfit(tt.estProfitTotal)} ({formatPct(tt.estProfitPct)})</span>
              </div>
            </div>
            {tt.isValid && (
              <>
                <div className="mt-2 space-y-1 text-xs">
                  <div className="flex justify-between text-muted-foreground">
                    <span>Shares</span>
                    <span>Max {opportunity.maxCloseShares.toFixed(1)}</span>
                  </div>
                  <input
                    type="number"
                    className="w-full px-2 py-1 border border-border rounded bg-background text-foreground text-xs"
                    value={ttQuantity}
                    min={0}
                    max={opportunity.maxCloseShares}
                    step={0.1}
                    onChange={(e) => {
                      const next = parseFloat(e.target.value);
                      setTtQuantity(Number.isFinite(next) ? next : 0);
                      setTtConfirming(false);
                      setTtError(null);
                    }}
                  />
                  <div className="text-[10px] text-muted-foreground">
                    Default {opportunity.matchedShares.toFixed(1)}
                  </div>
                  {ttQuantity > opportunity.maxCloseShares && (
                    <div className="text-[10px] text-red-500">
                      Exceeds max by depth
                    </div>
                  )}
                </div>
                <Button
                  size="sm"
                  variant={ttConfirming ? "destructive" : "outline"}
                  className={`w-full mt-2 text-xs ${ttConfirming && !ttSubmitting ? 'animate-pulse' : ''}`}
                  onClick={handleTtClick}
                  disabled={ttSubmitting || ttQuantity <= 0 || ttQuantity > opportunity.maxCloseShares}
                >
                  {ttSubmitting ? 'Submitting...' : ttConfirming ? 'Confirm (3s)' : 'T-T Close'}
                </Button>
                {ttError && (
                  <div className="mt-1 text-xs text-red-500 truncate" title={ttError}>
                    {ttError}
                  </div>
                )}
              </>
            )}
          </div>

          {/* M-T Mode */}
          <div className={`p-2 rounded border ${mt.isValid ? 'border-green-500/30 bg-green-500/5' : 'border-red-500/30 bg-red-500/5'}`}>
            <div className="flex items-center justify-between mb-1">
              <span className="text-xs font-medium">M-T (Maker)</span>
              {bestMode === 'MT' && <Badge variant="outline" className="text-xs">Best</Badge>}
            </div>
            <div className="space-y-1 text-xs">
              <div className="flex justify-between">
                <span className="text-muted-foreground">Predict Ask</span>
                <span className="font-mono">{formatPrice(mt.predictAsk)}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-muted-foreground">Poly Bid</span>
                <span className="font-mono">{formatPrice(mt.polyBid)}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-muted-foreground">Fee</span>
                <span className="font-mono text-green-400">0¢ (Maker)</span>
              </div>
              <div className={`flex justify-between font-medium ${mt.isValid ? 'text-green-500' : 'text-red-500'}`}>
                <span>Profit</span>
                <span>{formatProfit(mt.estProfitTotal)} ({formatPct(mt.estProfitPct)})</span>
              </div>
            </div>
            {onClose && mt.isValid && (
              <Button
                size="sm"
                variant="outline"
                className="w-full mt-2 text-xs"
                onClick={() => onClose(opportunity, 'MT')}
              >
                M-T Close
              </Button>
            )}
          </div>
        </div>

        {/* Expanded details */}
        {expanded && (
          <div className="text-xs space-y-1 pt-2 border-t">
            <div className="flex justify-between">
              <span className="text-muted-foreground">Market ID</span>
              <span className="font-mono">{opportunity.predictMarketId}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-muted-foreground">Sell Depth</span>
              <span className="font-mono">{opportunity.maxCloseShares.toFixed(1)} shares</span>
            </div>
            <div className="flex justify-between">
              <span className="text-muted-foreground">T-T Min Poly Bid</span>
              <span className="font-mono">{formatPrice(tt.minPolyBid)}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-muted-foreground">M-T Min Poly Bid</span>
              <span className="font-mono">{formatPrice(mt.minPolyBid)}</span>
            </div>
          </div>
        )}

        <Button
          variant="ghost"
          size="sm"
          className="w-full text-xs"
          onClick={() => setExpanded(!expanded)}
        >
          {expanded ? 'Collapse' : 'Details'}
        </Button>
      </CardContent>
    </Card>
  );
}
