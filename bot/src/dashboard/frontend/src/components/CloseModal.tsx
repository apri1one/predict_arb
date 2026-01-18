import { useState } from "react";
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

interface CloseModalProps {
  opportunity: CloseOpportunity;
  initialMode: 'TT' | 'MT';
  apiBase: string;
  onClose: () => void;
  onSuccess?: () => void;
}

function getAuthHeaders(): Record<string, string> {
  if (typeof window === 'undefined') return {};
  const token = localStorage.getItem('dashboardApiToken') || localStorage.getItem('DASHBOARD_API_TOKEN');
  return token ? { Authorization: `Bearer ${token}` } : {};
}

export function CloseModal({ opportunity, initialMode, apiBase, onClose, onSuccess }: CloseModalProps) {
  const [mode, setMode] = useState<'TT' | 'MT'>(initialMode);
  const [quantity, setQuantity] = useState(opportunity.maxCloseShares);
  const [predictAskPrice, setPredictAskPrice] = useState(opportunity.mt.predictAsk);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const { tt, mt } = opportunity;

  // Calculate dynamic minPolyBid for M-T mode based on user's predictAskPrice
  const calcMtMinPolyBid = () => {
    return opportunity.entryCostPerShare - predictAskPrice;
  };

  // Calculate profit based on current settings
  const calcProfit = () => {
    const qty = Math.min(quantity, opportunity.maxCloseShares);
    if (mode === 'TT') {
      const profitPerShare = (tt.predictBid - tt.predictFee) + tt.polyBid - opportunity.entryCostPerShare;
      return profitPerShare * qty;
    } else {
      // M-T: use user-specified predictAskPrice
      const profitPerShare = predictAskPrice + mt.polyBid - opportunity.entryCostPerShare;
      return profitPerShare * qty;
    }
  };

  const estimatedProfit = calcProfit();
  const dynamicMtMinPolyBid = calcMtMinPolyBid();
  const formatPrice = (p: number) => (p * 100).toFixed(1) + '¢';

  // Handle form submission
  const handleSubmit = async () => {
    setSubmitting(true);
    setError(null);

    try {
      const qty = Math.min(quantity, opportunity.maxCloseShares);

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
        polymarketMinBid: mode === 'TT' ? tt.minPolyBid : dynamicMtMinPolyBid,
        // Mode-specific
        strategy: mode === 'TT' ? 'TAKER' : 'MAKER',
        predictPrice: mode === 'TT' ? tt.predictBid : predictAskPrice,
        // MAKER mode specific
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
        throw new Error(errData.message || `HTTP ${res.status}`);
      }

      const result = await res.json();
      console.log('Close task created:', result);
      onSuccess?.();
      onClose();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      {/* Backdrop */}
      <div
        className="absolute inset-0 bg-black/60 backdrop-blur-sm"
        onClick={onClose}
      />

      {/* Modal */}
      <div className="relative bg-background border border-border rounded-lg shadow-xl w-full max-w-md mx-4 p-6 space-y-4">
        {/* Header */}
        <div className="flex items-start justify-between">
          <div>
            <h2 className="text-lg font-semibold">Create Close Task</h2>
            <p className="text-sm text-muted-foreground line-clamp-1">{opportunity.title}</p>
          </div>
          <button
            className="text-muted-foreground hover:text-foreground"
            onClick={onClose}
          >
            ✕
          </button>
        </div>

        {/* Mode Selection */}
        <div>
          <label className="text-sm font-medium mb-2 block">Close Mode</label>
          <div className="grid grid-cols-2 gap-2">
            <button
              className={`p-3 rounded border text-sm font-medium transition-colors ${
                mode === 'TT'
                  ? 'border-primary bg-primary/10 text-primary'
                  : 'border-border hover:border-primary/50'
              }`}
              onClick={() => setMode('TT')}
            >
              <div>T-T (Taker-Taker)</div>
              <div className="text-xs text-muted-foreground">Fast execution, with fee</div>
            </button>
            <button
              className={`p-3 rounded border text-sm font-medium transition-colors ${
                mode === 'MT'
                  ? 'border-primary bg-primary/10 text-primary'
                  : 'border-border hover:border-primary/50'
              }`}
              onClick={() => setMode('MT')}
            >
              <div>M-T (Maker-Taker)</div>
              <div className="text-xs text-muted-foreground">Limit order, no fee</div>
            </button>
          </div>
        </div>

        {/* Quantity Input */}
        <div>
          <label className="text-sm font-medium mb-2 block">
            Quantity <span className="text-muted-foreground">(max {opportunity.maxCloseShares.toFixed(1)})</span>
          </label>
          <input
            type="number"
            className="w-full px-3 py-2 border border-border rounded bg-background text-foreground"
            value={quantity}
            min={1}
            max={opportunity.maxCloseShares}
            step={0.1}
            onChange={(e) => setQuantity(Math.min(parseFloat(e.target.value) || 0, opportunity.maxCloseShares))}
          />
        </div>

        {/* M-T: Predict Ask Price */}
        {mode === 'MT' && (
          <div>
            <label className="text-sm font-medium mb-2 block">
              Predict Ask Price <span className="text-muted-foreground">(Best Ask: {formatPrice(mt.predictAsk)})</span>
            </label>
            <input
              type="number"
              className="w-full px-3 py-2 border border-border rounded bg-background text-foreground"
              value={predictAskPrice}
              min={0.01}
              max={0.99}
              step={0.01}
              onChange={(e) => setPredictAskPrice(parseFloat(e.target.value) || 0)}
            />
          </div>
        )}

        {/* Summary */}
        <div className="p-3 rounded bg-muted/30 space-y-2 text-sm">
          <div className="flex justify-between">
            <span className="text-muted-foreground">Mode</span>
            <span className="font-medium">{mode === 'TT' ? 'Taker-Taker' : 'Maker-Taker'}</span>
          </div>
          <div className="flex justify-between">
            <span className="text-muted-foreground">Quantity</span>
            <span className="font-mono">{quantity.toFixed(1)} shares</span>
          </div>
          <div className="flex justify-between">
            <span className="text-muted-foreground">Predict Price</span>
            <span className="font-mono">{formatPrice(mode === 'TT' ? tt.predictBid : predictAskPrice)}</span>
          </div>
          <div className="flex justify-between">
            <span className="text-muted-foreground">Poly Min Bid</span>
            <span className="font-mono">{formatPrice(mode === 'TT' ? tt.minPolyBid : dynamicMtMinPolyBid)}</span>
          </div>
          <div className="flex justify-between border-t border-border pt-2">
            <span className="text-muted-foreground">Est. Profit</span>
            <span className={`font-mono font-bold ${estimatedProfit >= 0 ? 'text-green-500' : 'text-red-500'}`}>
              {estimatedProfit >= 0 ? '+' : ''}${estimatedProfit.toFixed(2)}
            </span>
          </div>
        </div>

        {/* Error */}
        {error && (
          <div className="p-3 rounded bg-red-500/10 border border-red-500/30 text-red-500 text-sm">
            {error}
          </div>
        )}

        {/* Actions */}
        <div className="flex gap-2">
          <Button
            variant="outline"
            className="flex-1"
            onClick={onClose}
            disabled={submitting}
          >
            Cancel
          </Button>
          <Button
            className="flex-1"
            onClick={handleSubmit}
            disabled={submitting || quantity <= 0}
          >
            {submitting ? 'Submitting...' : 'Confirm Close'}
          </Button>
        </div>
      </div>
    </div>
  );
}
