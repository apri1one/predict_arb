import type { SportsSSEData, SportsMatchedMarket, SportsArbOpportunity } from "../types";
import { Card, CardContent, CardHeader, CardTitle } from "./ui/card";
import { Badge } from "./ui/badge";

interface SportsMarketListProps {
    data: SportsSSEData | null;
}

const SPORT_LABELS: Record<string, string> = {
    nba: 'NBA',
    nfl: 'NFL',
    nhl: 'NHL',
    mlb: 'MLB',
    epl: 'EPL',
    ucl: 'UCL',
    mma: 'MMA',
    lol: 'LoL',
};

const DIRECTION_LABELS: Record<string, string> = {
    away: 'Away',
    home: 'Home',
    draw: 'Draw',
};

/**
 * 从 Polymarket market slug 提取 event slug
 * market slug 格式: nba-xxx-xxx-YYYY-MM-DD[-spread-home-3pt5]
 * event slug 格式: nba-xxx-xxx-YYYY-MM-DD
 */
function extractPolymarketEventSlug(slug: string): string {
    if (!slug) return slug;
    // 匹配体育赛事格式: sport-team1-team2-YYYY-MM-DD
    const match = slug.match(/^([a-z]+-[a-z]+-[a-z]+-\d{4}-\d{2}-\d{2})/i);
    return match ? match[1] : slug;
}

function formatPercent(value: number): string {
    return `${value >= 0 ? '+' : ''}${value.toFixed(2)}%`;
}

function formatPrice(value: number): string {
    return `${(value * 100).toFixed(1)}¢`;
}

function OpportunityBadge({ opp }: { opp: SportsArbOpportunity }) {
    if (!opp.isValid) return null;
    return (
        <Badge variant={opp.mode === 'MAKER' ? 'default' : 'secondary'} className="text-xs">
            {DIRECTION_LABELS[opp.direction]} {opp.mode} {formatPercent(opp.profitPercent)}
        </Badge>
    );
}

function SportsMarketCard({ market }: { market: SportsMatchedMarket }) {
    const { orderbook } = market;
    const best = market.bestOpportunity;

    // 收集所有有效机会
    const validOpps: SportsArbOpportunity[] = [];
    if (market.awayMT?.isValid) validOpps.push(market.awayMT);
    if (market.awayTT?.isValid) validOpps.push(market.awayTT);
    if (market.homeMT?.isValid) validOpps.push(market.homeMT);
    if (market.homeTT?.isValid) validOpps.push(market.homeTT);
    if (market.drawMT?.isValid) validOpps.push(market.drawMT);
    if (market.drawTT?.isValid) validOpps.push(market.drawTT);

    const hasProfitableOpp = validOpps.length > 0;
    const bestProfit = best?.profitPercent ?? 0;

    return (
        <Card className={hasProfitableOpp ? 'border-green-500/50' : ''}>
            <CardHeader className="pb-2">
                <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2">
                        <Badge variant="outline" className="text-xs">
                            {SPORT_LABELS[market.sport] || market.sport.toUpperCase()}
                        </Badge>
                        {market.is3Way && (
                            <Badge variant="outline" className="text-xs bg-purple-500/20">
                                3-Way
                            </Badge>
                        )}
                    </div>
                    {hasProfitableOpp && (
                        <Badge className="bg-green-500 text-white">
                            {formatPercent(bestProfit)}
                        </Badge>
                    )}
                </div>
                <CardTitle className="text-sm font-medium mt-2">
                    {market.awayTeam} @ {market.homeTeam}
                </CardTitle>
                {market.gameDate && (
                    <div className="text-xs text-muted-foreground">
                        {market.gameDate} {market.gameStartTime || ''}
                    </div>
                )}
            </CardHeader>
            <CardContent className="space-y-3">
                {/* 订单簿价格 */}
                <div className="grid grid-cols-2 gap-4 text-xs">
                    {/* Predict 侧 */}
                    <div className="space-y-1">
                        <div className="font-semibold text-blue-400">Predict</div>
                        <div className="flex justify-between">
                            <span className="text-muted-foreground">Away:</span>
                            <span>{formatPrice(orderbook.predict.awayBid)} / {formatPrice(orderbook.predict.awayAsk)}</span>
                        </div>
                        <div className="flex justify-between">
                            <span className="text-muted-foreground">Home:</span>
                            <span>{formatPrice(orderbook.predict.homeBid)} / {formatPrice(orderbook.predict.homeAsk)}</span>
                        </div>
                        {market.is3Way && orderbook.predict.drawBid !== undefined && (
                            <div className="flex justify-between">
                                <span className="text-muted-foreground">Draw:</span>
                                <span>{formatPrice(orderbook.predict.drawBid)} / {formatPrice(orderbook.predict.drawAsk ?? 1)}</span>
                            </div>
                        )}
                    </div>
                    {/* Polymarket 侧 */}
                    <div className="space-y-1">
                        <div className="font-semibold text-purple-400">Polymarket</div>
                        <div className="flex justify-between">
                            <span className="text-muted-foreground">Away:</span>
                            <span>{formatPrice(orderbook.polymarket.awayBid)} / {formatPrice(orderbook.polymarket.awayAsk)}</span>
                        </div>
                        <div className="flex justify-between">
                            <span className="text-muted-foreground">Home:</span>
                            <span>{formatPrice(orderbook.polymarket.homeBid)} / {formatPrice(orderbook.polymarket.homeAsk)}</span>
                        </div>
                        {market.is3Way && orderbook.polymarket.drawBid !== undefined && (
                            <div className="flex justify-between">
                                <span className="text-muted-foreground">Draw:</span>
                                <span>{formatPrice(orderbook.polymarket.drawBid)} / {formatPrice(orderbook.polymarket.drawAsk ?? 1)}</span>
                            </div>
                        )}
                    </div>
                </div>

                {/* 套利机会 */}
                {validOpps.length > 0 && (
                    <div className="flex flex-wrap gap-1 pt-2 border-t border-border">
                        {validOpps.map((opp, idx) => (
                            <OpportunityBadge key={idx} opp={opp} />
                        ))}
                    </div>
                )}

                {/* 一致性警告 */}
                {market.consistency.warning && (
                    <div className="text-xs text-yellow-500 bg-yellow-500/10 px-2 py-1 rounded">
                        {market.consistency.warning}
                    </div>
                )}

                {/* 链接 */}
                <div className="flex gap-2 text-xs pt-2 border-t border-border">
                    {market.predictSlug && (
                        <a
                            href={`https://predict.fun/market/${market.predictSlug}`}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="text-blue-400 hover:underline"
                        >
                            Predict
                        </a>
                    )}
                    {market.polymarketSlug && (
                        <a
                            href={`https://polymarket.com/event/${extractPolymarketEventSlug(market.polymarketSlug)}`}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="text-purple-400 hover:underline"
                        >
                            Polymarket
                        </a>
                    )}
                </div>
            </CardContent>
        </Card>
    );
}

export function SportsMarketList({ data }: SportsMarketListProps) {
    if (!data) {
        return (
            <Card>
                <CardContent className="py-8 text-center text-muted-foreground">
                    Loading sports markets...
                </CardContent>
            </Card>
        );
    }

    const { markets, stats } = data;

    // 按是否有套利机会排序
    const sortedMarkets = [...markets].sort((a, b) => {
        const aProfit = a.bestOpportunity?.profitPercent ?? -999;
        const bProfit = b.bestOpportunity?.profitPercent ?? -999;
        return bProfit - aProfit;
    });

    return (
        <div className="space-y-4">
            {/* 统计摘要 */}
            <Card>
                <CardHeader className="pb-2">
                    <CardTitle className="text-lg">Sports Markets</CardTitle>
                </CardHeader>
                <CardContent>
                    <div className="grid grid-cols-4 gap-4 text-sm">
                        <div>
                            <div className="text-muted-foreground">Total Matched</div>
                            <div className="text-2xl font-bold">{stats.totalMatched}</div>
                        </div>
                        <div>
                            <div className="text-muted-foreground">With Arbitrage</div>
                            <div className="text-2xl font-bold text-green-500">{stats.withArbitrage}</div>
                        </div>
                        <div>
                            <div className="text-muted-foreground">Avg Profit</div>
                            <div className={`text-2xl font-bold ${stats.avgProfit > 0 ? 'text-green-500' : 'text-muted-foreground'}`}>
                                {stats.avgProfit > 0 ? formatPercent(stats.avgProfit) : '-'}
                            </div>
                        </div>
                        <div>
                            <div className="text-muted-foreground">Max Profit</div>
                            <div className={`text-2xl font-bold ${stats.maxProfit > 0 ? 'text-green-500' : 'text-muted-foreground'}`}>
                                {stats.maxProfit > 0 ? formatPercent(stats.maxProfit) : '-'}
                            </div>
                        </div>
                    </div>
                </CardContent>
            </Card>

            {/* 市场列表 */}
            {sortedMarkets.length === 0 ? (
                <Card>
                    <CardContent className="py-8 text-center text-muted-foreground">
                        No sports markets available
                    </CardContent>
                </Card>
            ) : (
                <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
                    {sortedMarkets.map((market) => (
                        <SportsMarketCard
                            key={`${market.predictMarketId}-${market.polymarketConditionId}`}
                            market={market}
                        />
                    ))}
                </div>
            )}
        </div>
    );
}
